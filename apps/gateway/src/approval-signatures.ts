/**
 * ADR-0186 A (dual control) and B (passkey-signed approvals) — slice A2+B.
 *
 * A TOOL-CALL APPROVAL (`mcp_tool`, `connector_call`) is decided here, not by
 * the generic one-row-one-decision write in `decideOneApproval` (app.ts calls
 * `decideToolCallApproval` for these kinds; every other kind is unchanged).
 *
 * DUAL CONTROL (A). At queue time (`toolApprovalRequirements`) the approval
 * snapshots `quorum` = max(the matched rules' quorums, the org's
 * `tool_approval_sensitive_quorum` when the call is attributed to a project
 * carrying an in-app-only data classification) and `signature_mode` (the org's
 * `approval_signature_mode`). The ELIGIBLE POOL is the named approver plus the
 * active members of the naming rule's `approver_role_id`; the caller is never
 * in it, nor is anyone linked to the caller by an active delegation. A
 * delegate decides for a pool member, and a delegator and their delegate are
 * ONE principal (`duplicate_approver` for the second). Any deny vetoes; the
 * approval flips to `approved` only when the distinct approving principals
 * reach the quorum, counted under `SELECT … FOR UPDATE` on the approval row.
 * A pool that can never reach its quorum is 422 `quorum_unsatisfiable` when a
 * rule is written and a DENIED, audited call at queue time.
 *
 * PASSKEY SIGNATURES (B, `signature_mode = passkey`, the strict default):
 *
 *   POST /v1/approvals/:approvalId/signing-options  (an eligible approver, in a browser)
 *        {decision} → {challengeId, options, signedPayload, expiresAt}
 *
 * The WebAuthn challenge is base64url(sha256(canonical approvalSigningPayload
 * {v, approvalId, decision, argumentsDigest, contextDigest, serverId |
 * connectorId, toolName, nonce})), user verification required, RP from
 * `REGULAIT_PUBLIC_URL` (unset → 409 `passkey_rp_unconfigured`, fail closed).
 * The decide (`passkey: {challengeId, response}`) claims the ceremony once,
 * verifies the assertion against one of the decider's unrevoked passkeys with
 * a strictly increasing counter, and stores payload, digest, assertion,
 * counter before and credential in `approval_decisions`. In `step_up` mode the
 * decide needs an `approval_decide` step-up instead; `off` records method
 * `none` (an audited relaxation). Chat taps and bulk decide can never sign.
 *
 * EXECUTION RECHECK (`recheckApprovalSignatures`, called by
 * `consumeBoundApproval` under the row lock): every approving signature is
 * re-verified against digests recomputed from the call actually run; any
 * mismatch supersedes the approval, refuses the call and audits
 * `approval-signature-recheck-failed`.
 *
 * Audit rows name principals and methods, never assertions or secrets.
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { generateAuthenticationOptions, verifyAuthenticationResponse, type AuthenticationResponseJSON } from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import {
  and,
  approvalAssignments,
  approvalDecisions,
  approvalDelegations,
  approvalRules,
  approvals,
  auditLog,
  complianceProfiles,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  or,
  projectMembers,
  projects,
  roleAssignments,
  roles,
  sql,
  users,
  webauthnChallenges,
  webauthnCredentials,
  type ApprovalDecisionRow,
  type SQL,
  type Db,
} from "@regulait/db";
import {
  APPROVAL_SIGNATURE_RECHECK_FAILED_RULE,
  TOOL_CALL_APPROVAL_OBJECT_TYPES,
  approvalSigningChallenge,
  approvalSigningDigest,
  approvalSigningOptionsSchema,
  approvalSigningPayload,
  canonicalJson,
  chatContentFenced,
  type ApprovalDecisionMethod,
  type ApprovalSignatureMode,
  type ApprovalSigningPayload,
} from "@regulait/shared";
import {
  PASSKEY_RP_UNCONFIGURED_BODY,
  STEP_UP_CEREMONY_SECONDS,
  WEBAUTHN_PROMPT_TIMEOUT_MS,
  activePasskeys,
  challengeClaimRefusal,
  checkStepUp,
  consumeWebauthnChallenge,
  loadStepUpPolicy,
  relyingParty,
  stepUpApplies,
  stepUpCallerOf,
} from "./step-up.js";
import { loadOrgSettings } from "./org-settings.js";
import { activeDelegationLinks, loadApprovalPool, principalRoots, requestedAtOf, type ApprovalPool } from "./approval-pool.js";
export {
  activeDelegationLinks,
  approvalRuleQuorumRefusal,
  loadApprovalPool,
  principalRoots,
  type ApprovalPool,
} from "./approval-pool.js";
import { projectPiiMode } from "./projects.js";

type ApprovalRow = typeof approvals.$inferSelect;
/** what a transaction handle and the pool have in common, for the helpers below */
type Q = Pick<Db, "select" | "update" | "insert">;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** is this approval a TOOL-CALL approval (the kinds signatures and quorum apply to)? */
export function isToolCallApproval(row: { objectType: string }): boolean {
  return (TOOL_CALL_APPROVAL_OBJECT_TYPES as readonly string[]).includes(row.objectType);
}

// ---------------------------------------------------------------------------
// Principals: the pool, delegation links, counting
// ---------------------------------------------------------------------------

/** the rule's approver role, when the approval names a rule row that has one */
async function approverRoleOf(db: Q, ruleId: string | null): Promise<string | null> {
  if (!ruleId || !UUID_RE.test(ruleId)) return null;
  const [rule] = await db
    .select({ approverRoleId: approvalRules.approverRoleId })
    .from(approvalRules)
    .where(eq(approvalRules.id, ruleId));
  return rule?.approverRoleId ?? null;
}

/** the audit rules whose rows record a move of an approval's named approver (with `previousApproverUserId`) */
const APPROVER_MOVED_RULES = ["approval-routed", "approval-claimed"] as const;

/**
 * B4S-02: WHO WAS NAMED when the call was queued. `approvals.approver_user_id`
 * can be re-pointed after queue time (a routing rule, a claim, an SLA
 * reassignment), and routing "decides whose queue this shows in, never who is
 * allowed to decide" — so the named-approver standing belongs to the approver
 * of the snapshot, not to whoever the row points at now. Every re-pointing
 * path creates the approval's assignment first, so:
 *  - no assignment → never routed or re-pointed: the stored approver;
 *  - the first routing/claim audit row → the approver it moved away from;
 *  - an assignment with no routing rule → its assignee, which mirrored the
 *    approver when it was made (an SLA reassignment comes after it);
 *  - otherwise (routed, with no record of who was named before) → null: no
 *    one has the named approver's standing (the strictest fallback).
 */
export async function snapshotNamedApprover(db: Q, row: ApprovalRow): Promise<string | null> {
  const [assignment] = await db
    .select({ ruleId: approvalAssignments.ruleId, assigneeId: approvalAssignments.assigneeId })
    .from(approvalAssignments)
    .where(eq(approvalAssignments.approvalId, row.id));
  if (!assignment) return row.approverUserId;
  const [moved] = await db
    .select({ detail: auditLog.detail })
    .from(auditLog)
    .where(and(inArray(auditLog.ruleId, [...APPROVER_MOVED_RULES]), sql`${auditLog.detail}->>'approvalId' = ${row.id}`))
    .orderBy(auditLog.seq)
    .limit(1);
  const previous = (moved?.detail as { previousApproverUserId?: unknown } | undefined)?.previousApproverUserId;
  if (moved) return typeof previous === "string" && UUID_RE.test(previous) ? previous : null;
  return assignment.ruleId === null ? assignment.assigneeId : null;
}

/**
 * The pool of a QUEUED approval row (B4S-02): the approver named when it was
 * queued plus the members of the approver role SNAPSHOTTED when it was queued
 * (`approvals.approver_role_id`, never the rule's current role), counted as of
 * `requested_at` — an account, or a role assignment, created after the call
 * was queued does not count — and active now. Delegations are read live (they
 * only ever merge principals or exclude the caller's links here).
 */
export async function poolForApproval(db: Q, row: ApprovalRow): Promise<ApprovalPool> {
  return loadApprovalPool(db, {
    namedApproverUserId: await snapshotNamedApprover(db, row),
    approverRoleId: row.approverRoleId,
    callerUserId: row.userId,
    asOf: requestedAtOf(row.id),
  });
}

/**
 * ADR-0186 A — WHICH TOOL-CALL APPROVALS a non-admin sees because of the
 * approver pool, built from the same facts `eligibilityOf` decides on: the
 * approver role SNAPSHOTTED on the approval (`poolForApproval`), held by the
 * viewer, or — for a pending approval — by someone the viewer is an active
 * delegate of (`delegators`, the live delegations the queue already uses), as
 * a delegate decides for a pool member. Never the viewer's own calls. Null
 * when the viewer and their delegators hold no role at all. Visibility is the
 * superset; the decide path re-checks eligibility in full (queue-time role
 * membership and delegation, account age, the caller's links).
 */
export async function poolVisibilityCondition(db: Q, viewerUserId: string, delegators: readonly string[]): Promise<SQL | null> {
  const people = [...new Set([viewerUserId, ...delegators])];
  const held = await db
    .select({ userId: roleAssignments.userId, roleId: roleAssignments.roleId })
    .from(roleAssignments)
    .where(inArray(roleAssignments.userId, people));
  const mine = [...new Set(held.filter((h) => h.userId === viewerUserId).map((h) => h.roleId))];
  const theirs = [...new Set(held.filter((h) => h.userId !== viewerUserId).map((h) => h.roleId))];
  const branches = [
    ...(mine.length ? [inArray(approvals.approverRoleId, mine)] : []),
    ...(theirs.length ? [and(inArray(approvals.approverRoleId, theirs), eq(approvals.status, "pending"))!] : []),
  ];
  if (branches.length === 0) return null;
  return and(
    inArray(approvals.objectType, [...TOOL_CALL_APPROVAL_OBJECT_TYPES]),
    sql`${approvals.userId} <> ${viewerUserId}`,
    or(...branches),
  )!;
}

// ---------------------------------------------------------------------------
// Queue time: the snapshot
// ---------------------------------------------------------------------------

/**
 * Is the call attributed to a project CARRYING an in-app-only data
 * classification? The project's own compliance tags resolve (through their
 * versioned profiles) to PII mode `block` — the same fence that makes an
 * approval in-app only for chat (ADR-0061). An unattributed call, or a
 * project with no tag that names a profile, is not.
 */
export async function projectIsSensitive(db: Q, projectId: string | null | undefined): Promise<boolean> {
  if (!projectId) return false;
  const [project] = await db.select({ tags: projects.classifications }).from(projects).where(eq(projects.id, projectId));
  const tags = (project?.tags ?? []) as string[];
  if (tags.length === 0) return false;
  const profiles = await db
    .select({ id: complianceProfiles.id })
    .from(complianceProfiles)
    .where(inArray(complianceProfiles.tag, tags));
  if (profiles.length === 0) return false;
  return chatContentFenced(await projectPiiMode(db as Db, projectId));
}

/** why a call is treated as touching sensitive data (B4S-03); empty = it is not */
export type SensitivitySource = "attributed_project" | "caller_membership";

/**
 * B4S-03 — is this call SENSITIVE, decided by the SERVER, never by the client
 * alone? The `x-regulait-project-id` attribution can only RAISE the answer:
 *
 *  - `attributed_project`: the project the call is attributed to carries an
 *    in-app-only classification (the header may name one; it is validated as
 *    billable by the caller before it gets here);
 *  - `caller_membership`: the calling person (a worker agent acts for the
 *    person who started it, so this is the initiating user) is a member of
 *    ANY project carrying one — omitting the header, or naming another
 *    project, cannot drop the sensitive quorum for someone who works on
 *    sensitive data.
 *
 * A server or connector carries no project binding in the schema (no column
 * or link table ties a target to a project), so the target cannot be a
 * source today (reported for the ADR as an open item).
 */
export async function callSensitivity(
  db: Q,
  input: { projectId: string | null | undefined; callerUserId: string },
): Promise<SensitivitySource[]> {
  const out: SensitivitySource[] = [];
  if (await projectIsSensitive(db, input.projectId)) out.push("attributed_project");
  const memberOf = await db
    .select({ id: projects.id })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(and(eq(projectMembers.userId, input.callerUserId), sql`jsonb_array_length(coalesce(${projects.classifications}, '[]'::jsonb)) > 0`));
  for (const p of memberOf) {
    if (p.id !== input.projectId && (await projectIsSensitive(db, p.id))) {
      out.push("caller_membership");
      break;
    }
  }
  return out;
}

export interface ToolApprovalRequirements {
  quorum: number;
  signatureMode: ApprovalSignatureMode;
  sensitive: boolean;
  /** what made it sensitive (B4S-03) */
  sensitiveBecause: SensitivitySource[];
  ruleQuorum: number;
  /** the naming rule's approver role, snapshotted onto the approval (`approvals.approver_role_id`) */
  approverRoleId: string | null;
  pool: ApprovalPool;
  satisfiable: boolean;
}

/** what a tool-call approval about to be queued must snapshot, and whether its pool can ever satisfy it */
export async function toolApprovalRequirements(
  db: Q,
  input: {
    callerUserId: string;
    approverUserId: string;
    /** the decision's rule id (the rule that names the approver), when it is an approval rule */
    ruleId: string | null;
    matchedApprovalRuleIds: readonly string[];
    projectId: string | null;
  },
): Promise<ToolApprovalRequirements> {
  const ids = [...new Set(input.matchedApprovalRuleIds.filter((id) => UUID_RE.test(id)))];
  const matched = ids.length
    ? await db.select({ quorum: approvalRules.quorum }).from(approvalRules).where(inArray(approvalRules.id, ids))
    : [];
  const ruleQuorum = Math.max(1, ...matched.map((r) => r.quorum));
  const org = await loadOrgSettings(db as Db);
  const sensitiveBecause = await callSensitivity(db, input);
  const sensitive = sensitiveBecause.length > 0;
  const quorum = Math.max(ruleQuorum, sensitive ? org.toolApprovalSensitiveQuorum : 1);
  const approverRoleId = await approverRoleOf(db, input.ruleId);
  const pool = await loadApprovalPool(db, {
    namedApproverUserId: input.approverUserId,
    approverRoleId,
    callerUserId: input.callerUserId,
  });
  return {
    quorum,
    signatureMode: org.approvalSignatureMode,
    sensitive,
    sensitiveBecause,
    ruleQuorum,
    approverRoleId,
    pool,
    satisfiable: pool.principals >= quorum,
  };
}

/** the audit row and refusal reason of a call denied at queue time because no pool can approve it */
export async function auditQuorumUnsatisfiableAtQueue(
  db: Q,
  input: {
    userId: string;
    req: ToolApprovalRequirements;
    projectId: string | null;
    target: { serverId: string; toolName: string } | { connectorId: string; toolName: string };
  },
): Promise<string> {
  const reason =
    `call to '${input.target.toolName}' needs ${input.req.quorum} different approvers` +
    (input.req.sensitiveBecause.includes("attributed_project")
      ? " (its project carries an in-app-only data classification)"
      : input.req.sensitive
        ? " (the caller works on a project that carries an in-app-only data classification)"
        : "") +
    `, but only ${input.req.pool.principals} eligible approver(s) exist besides the caller — denied rather than queued ` +
    "for an approval nobody could give";
  await db.insert(auditLog).values({
    userId: input.userId,
    ...("serverId" in input.target
      ? { objectType: "mcp_tool" as const, serverId: input.target.serverId, toolName: input.target.toolName }
      : { objectType: "connector" as const, objectId: input.target.connectorId, toolName: input.target.toolName }),
    detail: {
      phase: "approval-quorum",
      quorum: input.req.quorum,
      ruleQuorum: input.req.ruleQuorum,
      sensitive: input.req.sensitive,
      sensitiveBecause: input.req.sensitiveBecause,
      eligiblePrincipals: input.req.pool.principals,
      projectId: input.projectId,
    },
    effect: "deny",
    ruleId: "approval-quorum-unsatisfiable",
    ruleChain: [],
    reason,
  });
  return reason;
}

// ---------------------------------------------------------------------------
// The signed payload
// ---------------------------------------------------------------------------

/** the payload an approver signs for `row` (throws when the row cannot be bound: a legacy row) */
export function signingPayloadForRow(
  row: Pick<ApprovalRow, "id" | "argumentsDigest" | "contextDigest" | "serverId" | "connectorId" | "toolName" | "objectType">,
  decision: "approved" | "denied",
  nonce: string,
): ApprovalSigningPayload {
  return approvalSigningPayload({
    approvalId: row.id,
    decision,
    argumentsDigest: row.argumentsDigest ?? "",
    contextDigest: row.contextDigest ?? "",
    ...(row.objectType === "connector_call" ? { connectorId: row.connectorId } : { serverId: row.serverId }),
    toolName: row.toolName ?? "",
    nonce,
  });
}

function bindableRow(row: ApprovalRow): boolean {
  try {
    signingPayloadForRow(row, "approved", "A".repeat(43));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Eligibility of one decider
// ---------------------------------------------------------------------------

type Refusal = { ok: false; status: number; body: Record<string, unknown> };
const refuse = (status: number, body: Record<string, unknown>): Refusal => ({ ok: false, status, body });

interface Eligibility {
  ok: true;
  /** whose approval this counts as */
  principalUserId: string;
  /** the delegator, when the decider acts for them */
  onBehalfOf: string | null;
  /** the decider's identity set: themselves and everyone delegation-linked to them */
  identity: Set<string>;
  pool: ApprovalPool;
}

/** B4S-02 (b): was this passkey enrolled before the approval's call was queued? */
async function credentialPredates(db: Q, credentialRowId: string, approvalId: string): Promise<boolean> {
  const [hit] = await db
    .select({ id: webauthnCredentials.id })
    .from(webauthnCredentials)
    .where(and(eq(webauthnCredentials.id, credentialRowId), lt(webauthnCredentials.createdAt, requestedAtOf(approvalId))));
  return !!hit;
}

/** may `deciderUserId` decide `row`, as whom — and have they (as that principal) already? */
async function eligibilityOf(db: Q, row: ApprovalRow, deciderUserId: string, existing: readonly ApprovalDecisionRow[]): Promise<Eligibility | Refusal> {
  if (deciderUserId === row.userId) {
    return refuse(403, {
      error: "caller_cannot_approve",
      detail: "the person whose call this is can never decide its approval — someone else in the approver pool must",
    });
  }
  // B4S-02 (a)(e): the decider is an account that existed when the call was
  // queued and is active now — a principal created afterwards, or deactivated
  // since, never counts towards dual control
  const [decider] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, deciderUserId), isNull(users.disabledAt), lt(users.createdAt, requestedAtOf(row.id))));
  if (!decider) {
    return refuse(403, {
      error: "approver_not_eligible",
      detail:
        "only an active account that already existed when this call was queued can decide it — someone who was " +
        "eligible then must decide",
    });
  }
  const links = await activeDelegationLinks(db, [deciderUserId]);
  // (d): a delegation lets the decider act for a pool member only when it already existed when the call was queued
  const priorLinks = await activeDelegationLinks(db, [deciderUserId], { createdBefore: requestedAtOf(row.id) });
  // the decider's identity is their whole delegation component (a chain counts, not only a direct link)
  const roots = principalRoots([deciderUserId], links);
  const myRoot = roots.get(deciderUserId);
  const identity = new Set<string>([deciderUserId, ...[...roots].filter(([, r]) => r === myRoot).map(([id]) => id)]);
  if (identity.has(row.userId)) {
    return refuse(403, {
      error: "caller_cannot_approve",
      detail: "you are linked to the person whose call this is by an active delegation, so you count as them — someone else must decide",
    });
  }
  const pool = await poolForApproval(db, row);
  let principalUserId: string | null = null;
  let onBehalfOf: string | null = null;
  if (pool.members.includes(deciderUserId)) {
    principalUserId = deciderUserId;
  } else {
    const delegators = priorLinks.filter(([, to]) => to === deciderUserId).map(([from]) => from).filter((f) => pool.members.includes(f));
    if (delegators.length > 0) {
      principalUserId = delegators.includes(row.approverUserId) ? row.approverUserId : [...delegators].sort()[0]!;
      onBehalfOf = principalUserId;
    }
  }
  if (!principalUserId) {
    return refuse(403, {
      error: "not_the_named_approver",
      detail:
        "only the approver named when this call was queued, an active member of the rule's approver role since " +
        "before it was queued, or someone they had delegated to by then may decide this tool-call approval",
    });
  }
  identity.add(principalUserId);
  const dup = existing.find(
    (e) => (e.principalUserId && identity.has(e.principalUserId)) || (e.deciderUserId && identity.has(e.deciderUserId)),
  );
  if (dup) {
    return refuse(403, {
      error: "duplicate_approver",
      detail:
        "you (or the person you are linked to by delegation) already decided this approval; each approval must come " +
        "from a different person",
    });
  }
  return { ok: true, principalUserId, onBehalfOf, identity, pool };
}

/** the decisions recorded on an approval, oldest first */
export async function decisionsFor(db: Q, approvalId: string): Promise<ApprovalDecisionRow[]> {
  return db
    .select()
    .from(approvalDecisions)
    .where(eq(approvalDecisions.approvalId, approvalId))
    .orderBy(approvalDecisions.decidedAt, approvalDecisions.id);
}

/** distinct approving principals (delegation-linked principals count once) */
export async function approvingPrincipals(db: Q, decisions: readonly ApprovalDecisionRow[]): Promise<string[]> {
  const approved = decisions.filter((d) => d.decision === "approved" && d.principalUserId);
  const ids = approved.flatMap((d) => [d.principalUserId!, ...(d.deciderUserId ? [d.deciderUserId] : [])]);
  const links = await activeDelegationLinks(db, ids);
  const roots = principalRoots(ids, [
    ...links,
    ...approved.filter((d) => d.deciderUserId).map((d) => [d.principalUserId!, d.deciderUserId!] as [string, string]),
  ]);
  const seen = new Map<string, string>();
  for (const d of approved) {
    const r = roots.get(d.principalUserId!)!;
    if (!seen.has(r)) seen.set(r, d.principalUserId!);
  }
  return [...seen.values()];
}

/** the per-principal decision list the API shows (never the assertion) */
export function decisionView(d: ApprovalDecisionRow) {
  return {
    principalUserId: d.principalUserId,
    deciderUserId: d.deciderUserId,
    decision: d.decision,
    method: d.stepUpMethod,
    at: d.decidedAt,
  };
}

// ---------------------------------------------------------------------------
// The decide
// ---------------------------------------------------------------------------

/**
 * Test seam (red proof of the row lock): awaited inside the decide
 * transaction after the approving principals are counted and before the
 * approval is flipped or anything else is written (the audit chain's own
 * lock would otherwise serialise the race by accident). Never set outside tests.
 */
export const approvalQuorumTestHooks: { afterPrincipalsCounted: null | (() => Promise<void>) } = {
  afterPrincipalsCounted: null,
};

export interface ToolCallDecideInput {
  row: ApprovalRow;
  deciderUserId: string;
  decision: "approved" | "denied";
  reason: string | null;
  passkey?: { challengeId: string; response: Record<string, unknown> } | undefined;
  /** the HTTP request (required for the http channel: who signs, which session) */
  req?: FastifyRequest | undefined;
  channel: "http" | "chat" | "bulk";
}

export type ToolCallDecideResult =
  | Refusal
  | {
      ok: true;
      body: Record<string, unknown>;
      /** the row when this decision made the approval final (approved or denied), else null */
      finalized: ApprovalRow | null;
    };

async function auditSignatureFailure(db: Q, userId: string, row: ApprovalRow, why: string) {
  await db.insert(auditLog).values({
    userId,
    objectType: "approval",
    objectId: row.id,
    detail: { subsystem: "approval-signature", approvalId: row.id, why },
    effect: "deny",
    ruleId: "approval-signature-refused",
    ruleChain: [],
    reason: `a signed decision on approval '${row.id}' was refused: ${why}`,
  });
}

const PASSKEY_REQUIRED_DETAIL =
  "this tool-call approval must be signed with your passkey: get signing options (POST /v1/approvals/:id/signing-options " +
  "with the decision), sign them in your browser, and send the decision with `passkey: {challengeId, response}`";

/**
 * Decide one TOOL-CALL approval. Every refusal is returned (never thrown).
 * Order: eligibility (caller, pool, duplicate) → channel and signature mode →
 * proof (passkey assertion | step-up | none) → the locked transaction.
 */
export async function decideToolCallApproval(db: Db, input: ToolCallDecideInput): Promise<ToolCallDecideResult> {
  const { row, deciderUserId, decision } = input;
  if (row.status !== "pending") {
    return refuse(409, row.status === "superseded" ? { error: "approval_superseded" } : { error: "already_decided" });
  }
  const pre = await eligibilityOf(db, row, deciderUserId, await decisionsFor(db, row.id));
  if (!pre.ok) return pre;

  const mode = row.signatureMode as ApprovalSignatureMode;
  let method: ApprovalDecisionMethod = "none";
  let signature: {
    payload: ApprovalSigningPayload;
    digest: string;
    assertion: Record<string, unknown>;
    credentialRowId: string;
    counterBefore: number;
    newCounter: number;
    backedUp: boolean;
  } | null = null;

  if (mode === "passkey") {
    if (input.channel !== "http") {
      return refuse(409, {
        error: "approval_requires_individual_signature",
        detail:
          input.channel === "chat"
            ? "this approval must be signed with a passkey in RegulAIt — a chat tap cannot sign it"
            : "this approval must be signed with a passkey, one at a time — a bulk decision cannot sign it",
      });
    }
    const rp = relyingParty();
    if (!rp) return refuse(409, { ...PASSKEY_RP_UNCONFIGURED_BODY });
    const caller = input.req ? stepUpCallerOf(input.req) : null;
    if (!caller || caller.kind !== "session" || caller.userId !== deciderUserId) {
      return refuse(403, {
        error: "passkey_signature_required",
        detail: "only a person signed in to RegulAIt in a browser can sign an approval — an API key cannot",
      });
    }
    if (!input.passkey) return refuse(403, { error: "passkey_signature_required", detail: PASSKEY_REQUIRED_DETAIL });
    // ONE attempt per ceremony: claimed before the assertion is checked
    const claim = await consumeWebauthnChallenge(db, {
      id: input.passkey.challengeId,
      userId: deciderUserId,
      sessionId: caller.sessionId,
      purpose: "approval_sign",
    });
    if (!claim.ok) {
      const r = challengeClaimRefusal(claim.reason);
      await auditSignatureFailure(db, deciderUserId, row, `challenge_${claim.reason}`);
      return refuse(r.status, r.body);
    }
    const ceremony = claim.row;
    const invalid = async (why: string) => {
      await auditSignatureFailure(db, deciderUserId, row, why);
      return refuse(422, {
        error: "passkey_signature_invalid",
        detail: "the signature could not be verified for this decision — get new signing options and sign again",
      });
    };
    if (ceremony.approvalId !== row.id || ceremony.decision !== decision) return invalid("signed_for_another_decision");
    const signed = ceremony.signedPayload as ApprovalSigningPayload | null;
    let payload: ApprovalSigningPayload;
    try {
      payload = signingPayloadForRow(row, decision, String(signed?.nonce ?? ""));
    } catch {
      return refuse(409, { error: "approval_action_changed", detail: "this approval no longer describes a call that can be signed" });
    }
    const digest = approvalSigningDigest(payload);
    if (digest !== ceremony.actionDigest || canonicalJson(payload) !== canonicalJson(signed)) {
      await auditSignatureFailure(db, deciderUserId, row, "action_changed");
      return refuse(409, {
        error: "approval_action_changed",
        detail: "the call this approval describes changed after you were asked to sign it — get new signing options",
      });
    }
    const challenge = approvalSigningChallenge(payload);
    if (challenge !== ceremony.challenge) return invalid("challenge_mismatch");
    const response = input.passkey.response as unknown as AuthenticationResponseJSON;
    const credentialId = typeof response?.id === "string" ? response.id : "";
    const [cred] = credentialId
      ? await db
          .select()
          .from(webauthnCredentials)
          .where(
            and(
              eq(webauthnCredentials.credentialId, credentialId),
              eq(webauthnCredentials.userId, deciderUserId),
              isNull(webauthnCredentials.revokedAt),
            ),
          )
      : [];
    if (!cred) return invalid("unknown_or_revoked_credential");
    // B4S-02 (b): the passkey that signs must have been enrolled before the call was queued
    if (!(await credentialPredates(db, cred.id, row.id))) {
      await auditSignatureFailure(db, deciderUserId, row, "credential_enrolled_after_request");
      return refuse(403, {
        error: "passkey_enrolled_after_request",
        detail: "this passkey was enrolled after the call was queued — sign with a passkey you already had then",
      });
    }
    let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verified = await verifyAuthenticationResponse({
        response,
        expectedChallenge: ceremony.challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        credential: {
          id: cred.credentialId,
          publicKey: isoBase64URL.toBuffer(cred.publicKey),
          counter: cred.counter,
          transports: cred.transports,
        },
        requireUserVerification: true,
      });
    } catch (err) {
      return invalid(`verification_error: ${err instanceof Error ? err.message.slice(0, 200) : "unknown"}`);
    }
    if (!verified.verified || !verified.authenticationInfo.userVerified) return invalid("not_verified");
    method = "passkey";
    signature = {
      payload,
      digest,
      assertion: input.passkey.response,
      credentialRowId: cred.id,
      counterBefore: cred.counter,
      newCounter: verified.authenticationInfo.newCounter,
      backedUp: verified.authenticationInfo.credentialBackedUp,
    };
  } else if (mode === "step_up") {
    if (input.channel !== "http") {
      const policy = await loadStepUpPolicy(db);
      if (stepUpApplies(policy, "approval_decide")) {
        return input.channel === "chat"
          ? refuse(403, {
              error: "chatops_step_up_required",
              actionKind: "approval_decide",
              methods: [],
              detail: "a decision from chat cannot confirm who made it: open it in RegulAIt and confirm it's you there",
            })
          : refuse(409, {
              error: "approval_requires_individual_signature",
              detail: "this approval needs you to confirm it's you, one at a time — a bulk decision cannot",
            });
      }
    } else {
      if (!input.req) return refuse(403, { error: "step_up_required", actionKind: "approval_decide", methods: [] });
      const su = await checkStepUp(db, input.req, {
        kind: "approval_decide",
        facts: { approvalId: row.id, decision },
      });
      if (!su.ok) return refuse(su.status, su.body);
      method = su.method === "passkey" || su.method === "totp" || su.method === "sso" ? su.method : "none";
    }
  }

  // ---- the locked transaction ---------------------------------------------
  const out = await db.transaction(async (tx) => {
    // THE ROW LOCK: every decide on this approval serialises here, so the
    // count below always sees every decision committed before it.
    const [locked] = await tx.select().from(approvals).where(eq(approvals.id, row.id)).for("update");
    if (!locked || locked.status !== "pending") {
      return { refusal: refuse(409, locked?.status === "superseded" ? { error: "approval_superseded" } : { error: "already_decided" }) };
    }
    const existing = await decisionsFor(tx, row.id);
    const el = await eligibilityOf(tx, locked, deciderUserId, existing);
    if (!el.ok) return { refusal: el };
    if (signature) {
      // the counter moves forward once: a replayed or concurrent assertion matches no row
      const [moved] = await tx
        .update(webauthnCredentials)
        .set({ counter: signature.newCounter, lastUsedAt: sql`now()`, backedUp: signature.backedUp })
        .where(
          and(
            eq(webauthnCredentials.id, signature.credentialRowId),
            eq(webauthnCredentials.counter, signature.counterBefore),
            isNull(webauthnCredentials.revokedAt),
          ),
        )
        .returning({ id: webauthnCredentials.id });
      if (!moved) {
        return {
          refusal: refuse(422, {
            error: "passkey_signature_invalid",
            detail: "the signature could not be verified for this decision — get new signing options and sign again",
          }),
          auditWhy: "counter_race",
        };
      }
    }
    const [recorded] = await tx
      .insert(approvalDecisions)
      .values({
        approvalId: row.id,
        deciderUserId,
        principalUserId: el.principalUserId,
        decision,
        reason: input.reason,
        stepUpMethod: method,
        credentialId: signature?.credentialRowId ?? null,
        signedPayload: signature?.payload ?? null,
        signedDigest: signature?.digest ?? null,
        assertion: signature?.assertion ?? null,
        counterBefore: signature?.counterBefore ?? null,
      })
      .returning();
    const all = await decisionsFor(tx, row.id);
    const principals = await approvingPrincipals(tx, all);
    if (approvalQuorumTestHooks.afterPrincipalsCounted) await approvalQuorumTestHooks.afterPrincipalsCounted();
    // the per-principal record (receipts cover it): who, as whom, how — never the assertion
    await tx.insert(auditLog).values({
      userId: deciderUserId,
      objectType: "approval",
      objectId: row.id,
      serverId: row.serverId,
      toolName: row.toolName,
      detail: {
        approvalId: row.id,
        approvalObjectType: row.objectType,
        principalUserId: el.principalUserId,
        deciderUserId,
        ...(el.onBehalfOf ? { onBehalfOfUserId: el.onBehalfOf } : {}),
        decision,
        method,
        signatureMode: mode,
        ...(signature ? { credentialId: signature.credentialRowId, signedDigest: signature.digest } : {}),
        quorum: locked.quorum,
      },
      effect: decision === "approved" ? "allow" : "deny",
      ruleId: "approval-decision-recorded",
      ruleChain: [],
      reason:
        `${decision} by principal ${el.principalUserId}` +
        (el.onBehalfOf ? ` (decided by delegate ${deciderUserId})` : "") +
        ` with method ${method}`,
    });
    let finalized: ApprovalRow | null = null;
    if (decision === "denied") {
      finalized =
        (
          await tx
            .update(approvals)
            .set({ status: "denied", decidedBy: deciderUserId, decidedAt: new Date(), decisionReason: input.reason })
            .where(and(eq(approvals.id, row.id), eq(approvals.status, "pending")))
            .returning()
        )[0] ?? null;
      await tx.insert(auditLog).values({
        userId: deciderUserId,
        objectType: "approval",
        objectId: row.id,
        serverId: row.serverId,
        toolName: row.toolName,
        detail: {
          approvalId: row.id,
          vetoedByPrincipalUserId: el.principalUserId,
          deciderUserId,
          method,
          approvingPrincipalUserIds: principals,
          quorum: locked.quorum,
        },
        effect: "deny",
        ruleId: "approval-vetoed",
        ruleChain: [],
        reason: `denied by principal ${el.principalUserId}: any deny vetoes a tool-call approval`,
      });
    } else if (principals.length >= locked.quorum) {
      finalized =
        (
          await tx
            .update(approvals)
            .set({ status: "approved", decidedBy: deciderUserId, decidedAt: new Date(), decisionReason: input.reason })
            .where(and(eq(approvals.id, row.id), eq(approvals.status, "pending")))
            .returning()
        )[0] ?? null;
      const methods = Object.fromEntries(
        all.filter((d) => d.decision === "approved" && d.principalUserId).map((d) => [d.principalUserId!, d.stepUpMethod]),
      );
      await tx.insert(auditLog).values({
        userId: deciderUserId,
        objectType: "approval",
        objectId: row.id,
        serverId: row.serverId,
        toolName: row.toolName,
        detail: { approvalId: row.id, approvingPrincipalUserIds: principals, methods, quorum: locked.quorum, signatureMode: mode },
        effect: "allow",
        ruleId: "approval-quorum-reached",
        ruleChain: [],
        reason: `${principals.length} of ${locked.quorum} required approvers approved: the call may run once`,
      });
    }
    const [after] = finalized ? [finalized] : await tx.select().from(approvals).where(eq(approvals.id, row.id));
    return { recorded: recorded!, after: after!, all, principals, finalized, el };
  });
  if ("refusal" in out && out.refusal) {
    if ("auditWhy" in out && out.auditWhy) await auditSignatureFailure(db, deciderUserId, row, out.auditWhy);
    return out.refusal;
  }
  const done = out as Exclude<typeof out, { refusal: Refusal }>;
  return {
    ok: true,
    finalized: done.finalized,
    body: {
      ...done.after,
      status: done.after.status,
      approvals: done.principals.length,
      quorum: done.after.quorum,
      decisions: done.all.map(decisionView),
      ...(done.el.onBehalfOf ? { onBehalfOf: done.el.onBehalfOf } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// The execution recheck
// ---------------------------------------------------------------------------

export interface CallFacts {
  argumentsDigest: string;
  contextDigest: string;
  serverId?: string | null;
  connectorId?: string | null;
  toolName: string;
}

export type RecheckOutcome = { ok: true } | { ok: false; why: string; principalUserId?: string | null };

/**
 * B4S-09: is every APPROVING decider of `row` still eligible, by the same
 * predicate the decide applies (B4S-02)? The decider is an active account
 * created before the call was queued; the principal they counted as is still
 * in the approval's pool (the approver named then, or a member of the approver
 * role since before then, active now); a decision made on someone's behalf
 * still rides a live delegation created before the call was queued; and
 * neither is linked to the caller by a delegation. Any failure fails the whole
 * approval (fail closed): the people who approved must still be people who may.
 */
async function recheckDeciders(db: Q, row: ApprovalRow, decisions: readonly ApprovalDecisionRow[]): Promise<RecheckOutcome> {
  if (decisions.length === 0) return { ok: true };
  const pool = await poolForApproval(db, row);
  for (const d of decisions) {
    const fail = (why: string): RecheckOutcome => ({ ok: false, why, principalUserId: d.principalUserId });
    if (!d.deciderUserId || !d.principalUserId) return fail("decider_unknown");
    const [decider] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, d.deciderUserId), isNull(users.disabledAt), lt(users.createdAt, requestedAtOf(row.id))));
    if (!decider) return fail("decider_ineligible");
    if (!pool.members.includes(d.principalUserId)) return fail("principal_ineligible");
    const live = await activeDelegationLinks(db, [d.deciderUserId]);
    if (live.some(([from, to]) => from === row.userId || to === row.userId)) return fail("decider_linked_to_caller");
    if (d.deciderUserId !== d.principalUserId) {
      const prior = await activeDelegationLinks(db, [d.deciderUserId], { createdBefore: requestedAtOf(row.id) });
      if (!prior.some(([from, to]) => from === d.principalUserId && to === d.deciderUserId)) return fail("delegation_ineligible");
    }
  }
  return { ok: true };
}

/**
 * THE EXECUTION RECHECK of a tool-call approval, under the consuming row lock.
 * B4S-09: every approving decider is still eligible (`recheckDeciders`), in
 * every signature mode. Then, in passkey mode, EVERY approving signature is
 * re-verified against the payload recomputed from the call actually being
 * run. Any mismatch (payload, digest, assertion, credential gone, revoked or
 * enrolled after the call was queued, fewer valid principals than the
 * snapshotted quorum) fails the whole approval. Rows in `step_up` / `off` mode
 * carry no signature to recheck.
 */
export async function recheckApprovalSignatures(db: Q, row: ApprovalRow, call: CallFacts | null): Promise<RecheckOutcome> {
  if (!isToolCallApproval(row)) return { ok: true };
  const decisions = (await decisionsFor(db, row.id)).filter((d) => d.decision === "approved");
  const deciders = await recheckDeciders(db, row, decisions);
  if (!deciders.ok) return deciders;
  if (row.signatureMode !== "passkey") return { ok: true };
  if (!call) return { ok: false, why: "no_call_facts" };
  const rp = relyingParty();
  if (!rp) return { ok: false, why: "passkey_rp_unconfigured" };
  const valid: ApprovalDecisionRow[] = [];
  for (const d of decisions) {
    const fail = (why: string): RecheckOutcome => ({ ok: false, why, principalUserId: d.principalUserId });
    const stored = d.signedPayload as ApprovalSigningPayload | null;
    if (!stored || !d.signedDigest || !d.assertion || d.counterBefore == null || !d.credentialId) return fail("unsigned_decision");
    let expected: ApprovalSigningPayload;
    try {
      expected = approvalSigningPayload({
        approvalId: row.id,
        decision: "approved",
        argumentsDigest: call.argumentsDigest,
        contextDigest: call.contextDigest,
        ...(row.objectType === "connector_call" ? { connectorId: call.connectorId ?? null } : { serverId: call.serverId ?? null }),
        toolName: call.toolName,
        nonce: String(stored.nonce ?? ""),
      });
    } catch {
      return fail("call_not_bindable");
    }
    if (canonicalJson(expected) !== canonicalJson(stored) || approvalSigningDigest(expected) !== d.signedDigest) {
      return fail("payload_mismatch");
    }
    const [cred] = await db.select().from(webauthnCredentials).where(eq(webauthnCredentials.id, d.credentialId));
    if (!cred || cred.revokedAt || cred.userId !== d.deciderUserId) return fail("credential_unusable");
    if (!(await credentialPredates(db, cred.id, row.id))) return fail("credential_enrolled_after_request");
    try {
      const v = await verifyAuthenticationResponse({
        response: d.assertion as unknown as AuthenticationResponseJSON,
        expectedChallenge: approvalSigningChallenge(expected),
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        credential: {
          id: cred.credentialId,
          publicKey: isoBase64URL.toBuffer(cred.publicKey),
          counter: d.counterBefore,
          transports: cred.transports,
        },
        requireUserVerification: true,
      });
      if (!v.verified || !v.authenticationInfo.userVerified) return fail("signature_invalid");
    } catch {
      return fail("signature_invalid");
    }
    valid.push(d);
  }
  // counted exactly as the decide counts them: a delegator and their delegate once
  if ((await approvingPrincipals(db, valid)).length < row.quorum) return { ok: false, why: "below_quorum" };
  return { ok: true };
}

/** supersede an approval whose signatures failed the recheck, and audit it (inside the consuming transaction) */
export async function supersedeOnRecheckFailure(db: Q, row: ApprovalRow, call: CallFacts | null, outcome: Extract<RecheckOutcome, { ok: false }>) {
  const signatureFailure = !/ineligible|unknown|linked_to_caller/.test(outcome.why);
  await db
    .update(approvals)
    .set({
      status: "superseded",
      decisionReason: signatureFailure
        ? "superseded: an approving signature did not verify against the call that tried to run"
        : "superseded: someone who approved is no longer eligible to approve it",
    })
    .where(and(eq(approvals.id, row.id), eq(approvals.status, "approved")));
  await db.insert(auditLog).values({
    userId: row.userId,
    objectType: "approval",
    objectId: row.id,
    serverId: row.serverId,
    toolName: row.toolName,
    detail: {
      approvalId: row.id,
      approvalObjectType: row.objectType,
      why: outcome.why,
      ...(outcome.principalUserId ? { principalUserId: outcome.principalUserId } : {}),
      quorum: row.quorum,
      ...(call ? { callArgumentsDigest: call.argumentsDigest, callContextDigest: call.contextDigest } : {}),
    },
    effect: "deny",
    ruleId: APPROVAL_SIGNATURE_RECHECK_FAILED_RULE,
    ruleChain: [],
    reason: signatureFailure
      ? `approval '${row.id}' was superseded and the call refused: its approving signatures did not verify against ` +
        `the call that tried to run (${outcome.why})`
      : `approval '${row.id}' was superseded and the call refused: an approving decider is no longer eligible ` +
        `(${outcome.why}) — the people who approved must still be people who may`,
  });
}

// ---------------------------------------------------------------------------
// Posture
// ---------------------------------------------------------------------------

/** the org-posture block: signing mode, and whether passkey mode can work at all */
export function approvalSigningPosture(mode: ApprovalSignatureMode, env: NodeJS.ProcessEnv = process.env) {
  const rpConfigured = relyingParty(env) !== null;
  const failClosed = mode === "passkey" && !rpConfigured;
  return {
    mode,
    rpConfigured,
    failClosed,
    ...(failClosed
      ? {
          finding:
            "tool-call approvals must be passkey-signed but REGULAIT_PUBLIC_URL is not set, so no passkey can sign: " +
            "every such approval fails closed until an operator sets it",
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// The signing-options route
// ---------------------------------------------------------------------------

export function registerApprovalSigningRoutes(app: FastifyInstance, db: Db): void {
  app.post("/v1/approvals/:approvalId/signing-options", async (req, reply) => {
    const { approvalId } = (req.params ?? {}) as { approvalId?: string };
    if (!approvalId || !UUID_RE.test(approvalId)) return reply.status(404).send({ error: "unknown_approval" });
    const caller = stepUpCallerOf(req);
    if (caller.kind !== "session") {
      return reply.status(403).send({
        error: "passkey_signature_required",
        detail: "only a person signed in to RegulAIt in a browser can sign an approval — an API key cannot",
      });
    }
    const body = approvalSigningOptionsSchema.parse(req.body ?? {});
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    if (!row) return reply.status(404).send({ error: "unknown_approval" });
    if (!isToolCallApproval(row) || row.signatureMode !== "passkey") {
      return reply.status(409).send({
        error: "approval_not_signable",
        detail: "this approval is not decided with a passkey signature",
      });
    }
    if (row.status !== "pending") {
      return reply.status(409).send(row.status === "superseded" ? { error: "approval_superseded" } : { error: "already_decided" });
    }
    const rp = relyingParty();
    if (!rp) return reply.status(409).send(PASSKEY_RP_UNCONFIGURED_BODY);
    const el = await eligibilityOf(db, row, caller.userId, await decisionsFor(db, row.id));
    if (!el.ok) return reply.status(el.status).send(el.body);
    if (!bindableRow(row)) {
      return reply.status(409).send({ error: "approval_action_changed", detail: "this approval no longer describes a call that can be signed" });
    }
    const all = await activePasskeys(db, caller.userId);
    if (all.length === 0) {
      return reply.status(403).send({
        error: "passkey_signature_required",
        enrolled: false,
        detail: "approving a tool call needs a passkey: enrol one on your Account page first",
      });
    }
    // B4S-02 (b): only a passkey enrolled before the call was queued may sign it
    const prior = new Set(
      (
        await db
          .select({ id: webauthnCredentials.id })
          .from(webauthnCredentials)
          .where(and(eq(webauthnCredentials.userId, caller.userId), lt(webauthnCredentials.createdAt, requestedAtOf(row.id))))
      ).map((c) => c.id),
    );
    const creds = all.filter((c) => prior.has(c.id));
    if (creds.length === 0) {
      return reply.status(403).send({
        error: "passkey_enrolled_after_request",
        detail: "your passkeys were all enrolled after this call was queued — only one you already had then can sign it",
      });
    }
    // hygiene: this user's own long-finished signing ceremonies
    await db
      .delete(webauthnChallenges)
      .where(
        and(
          eq(webauthnChallenges.userId, caller.userId),
          eq(webauthnChallenges.purpose, "approval_sign"),
          lt(webauthnChallenges.expiresAt, sql`now() - interval '1 hour'`),
        ),
      );
    const payload = signingPayloadForRow(row, body.decision, randomBytes(32).toString("base64url"));
    const challenge = approvalSigningChallenge(payload);
    const options = await generateAuthenticationOptions({
      rpID: rp.rpID,
      allowCredentials: creds.map((c) => ({ id: c.credentialId, transports: c.transports })),
      // the raw digest bytes: the options' challenge is then exactly base64url(sha256(payload))
      challenge: isoBase64URL.toBuffer(challenge),
      userVerification: "required",
      timeout: WEBAUTHN_PROMPT_TIMEOUT_MS,
    });
    if (options.challenge !== challenge) throw new Error("signing challenge was re-encoded");
    const [ceremony] = await db
      .insert(webauthnChallenges)
      .values({
        userId: caller.userId,
        sessionId: caller.sessionId,
        purpose: "approval_sign",
        challenge,
        actionDigest: approvalSigningDigest(payload),
        approvalId: row.id,
        decision: body.decision,
        signedPayload: payload,
        expiresAt: sql`now() + make_interval(secs => ${STEP_UP_CEREMONY_SECONDS})`,
      })
      .returning();
    return {
      challengeId: ceremony!.id,
      options,
      signedPayload: payload,
      expiresAt: ceremony!.expiresAt.toISOString(),
    };
  });
}
