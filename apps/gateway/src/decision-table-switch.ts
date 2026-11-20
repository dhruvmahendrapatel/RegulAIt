/**
 * ADR-0327 slice 4d: switch an AI step to its published decision table, and back.
 *
 *  - The same switch lifecycle as a detector suggestion (`RULE_STEP_SWITCH_MACHINE`, one `rule_step_switches` row per
 *    request): asked for by an admin with a user identity and step-up, decided by a named active administrator other
 *    than the requester in the approvals queue (`object_type` `rule_step_switch`), reverted by an admin in one action.
 *  - The request is bound to ONE published version: `rule_sha256` is that version's body digest, and the approval
 *    carries it. The decide path switches only while that version is still the published one and its body still hashes
 *    to the digest; otherwise the request is recorded `stale`. Publishing a newer version reverts a live switch of the
 *    old one in the same transaction (`revertSwitchOfSupersededVersion`): a newly published table never starts
 *    answering without its own approved switch.
 *  - One live switch per step: a table switch is refused while the step's detector suggestion is switched or asked to
 *    be, and the suggestion's switch route refuses the other way round.
 *  - Nothing here is an authorisation decision, and nothing here calls a model (ADR-0327 §Decision 5).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  and,
  approvals,
  decisionTables,
  decisionTableVersions,
  desc,
  eq,
  inArray,
  ruleStepSuggestions,
  ruleStepSwitches,
  sql,
  users,
  type Db,
} from "@regulait/db";
import { ruleStepRuleDigest } from "./rule-step-serve.js";
import { RULE_STEP_AUDIT_RULE_IDS, RULE_STEP_SWITCH_PREFIX, switchAudit, switchView, transitionSwitch } from "./rule-steps.js";
import { requireStepUp } from "./step-up.js";

const idParam = z.object({ id: z.string().uuid() }).strict();
const switchBody = z.object({ reviewerUserId: z.string().uuid(), reason: z.string().trim().min(1).max(500) }).strict();
const revertBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const OPEN = ["pending_review", "switched"] as const;

/** the latest switch request of any version of this table, with the version it was for */
export async function latestTableSwitch(db: Db, tableId: string) {
  const [row] = await db
    .select({ w: ruleStepSwitches, version: decisionTableVersions.version })
    .from(ruleStepSwitches)
    .innerJoin(decisionTableVersions, eq(decisionTableVersions.id, ruleStepSwitches.decisionTableVersionId))
    .where(eq(decisionTableVersions.tableId, tableId))
    .orderBy(desc(ruleStepSwitches.requestedAt), desc(ruleStepSwitches.id))
    .limit(1);
  return row ? { ...switchView(row.w)!, decisionTableVersionId: row.w.decisionTableVersionId, version: row.version } : null;
}

async function openTableSwitch(db: Db, tableId: string, statuses: readonly ("pending_review" | "switched")[]) {
  const [row] = await db
    .select({ id: ruleStepSwitches.id, approvalId: ruleStepSwitches.approvalId, status: ruleStepSwitches.status })
    .from(ruleStepSwitches)
    .innerJoin(decisionTableVersions, eq(decisionTableVersions.id, ruleStepSwitches.decisionTableVersionId))
    .where(and(eq(decisionTableVersions.tableId, tableId), inArray(ruleStepSwitches.status, [...statuses])))
    .limit(1);
  return row ?? null;
}

/** is the step's detector suggestion switched, or asked to be? (one live switch per step) */
async function suggestionHoldsStep(db: Db, agentId: string, stepName: string): Promise<boolean> {
  const [s] = await db
    .select({ id: ruleStepSuggestions.id, status: ruleStepSuggestions.status })
    .from(ruleStepSuggestions)
    .where(and(eq(ruleStepSuggestions.agentId, agentId), eq(ruleStepSuggestions.stepName, stepName)));
  if (!s) return false;
  if (s.status === "switched") return true;
  const [open] = await db
    .select({ id: ruleStepSwitches.id })
    .from(ruleStepSwitches)
    .where(and(eq(ruleStepSwitches.suggestionId, s.id), inArray(ruleStepSwitches.status, [...OPEN])))
    .limit(1);
  return !!open;
}

export function registerDecisionTableSwitchRoutes(app: FastifyInstance, db: Db): void {
  /** ask for the step to be answered by the table's published version; nothing changes until the named reviewer approves */
  app.post("/v1/decision-tables/:id/switch", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const parsed = switchBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body", issues: parsed.error.issues.slice(0, 20) });
    const body = parsed.data;
    const actor = req.authCtx.userId ?? null;
    if (!actor) {
      return reply.status(422).send({ error: "user_identity_required", detail: "a switch is requested by a person, so its reviewer can be someone else" });
    }
    if (body.reviewerUserId === actor) {
      return reply.status(422).send({ error: "reviewer_is_requester", detail: "a switch is reviewed by someone other than the person who asked for it" });
    }
    const [reviewer] = await db.select({ isAdmin: users.isAdmin, disabledAt: users.disabledAt }).from(users).where(eq(users.id, body.reviewerUserId));
    if (!reviewer || reviewer.disabledAt !== null || !reviewer.isAdmin) {
      return reply.status(422).send({ error: "reviewer_not_eligible", detail: "the reviewer must be an active administrator" });
    }
    if (!(await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { ruleSteps: "switch", decisionTableId: id } })).ok) return reply;
    const out = await db.transaction(async (tx) => {
      const t0 = tx as unknown as Db;
      // one request at a time per table: the table row is the lock, as it is for its versions
      const [table] = await tx.select().from(decisionTables).where(eq(decisionTables.id, id)).for("update");
      if (!table) return { status: 404, body: { error: "unknown_decision_table" } } as const;
      const [published] = await tx
        .select()
        .from(decisionTableVersions)
        .where(and(eq(decisionTableVersions.tableId, id), eq(decisionTableVersions.status, "published")));
      if (!published) {
        return { status: 409, body: { error: "no_published_version", detail: "a table answers a step only once a version of it is published" } } as const;
      }
      const open = await openTableSwitch(t0, id, OPEN);
      if (open) return { status: 409, body: { error: "switch_pending", approvalId: open.approvalId } } as const;
      if (await suggestionHoldsStep(t0, table.agentId, table.stepName)) {
        return {
          status: 409,
          body: { error: "step_switched_to_suggestion", detail: "this step is switched, or asked to be, to its detected rule; revert that first" },
        } as const;
      }
      const digest = ruleStepRuleDigest(published.body);
      if (digest !== published.bodySha256) {
        return { status: 409, body: { error: "decision_table_version_digest_mismatch", detail: "the published body no longer matches its digest" } } as const;
      }
      const [w] = await tx
        .insert(ruleStepSwitches)
        .values({ decisionTableVersionId: published.id, ruleSha256: digest, requestedBy: actor, reason: body.reason })
        .returning();
      const [a] = await tx
        .insert(approvals)
        .values({
          userId: actor,
          objectType: "rule_step_switch",
          stageId: `${RULE_STEP_SWITCH_PREFIX}${w!.id}`,
          approverUserId: body.reviewerUserId,
          // the consent is for exactly this version's body (ADR-0104's fingerprint column)
          argumentsDigest: digest,
        })
        .returning({ id: approvals.id });
      await tx.update(ruleStepSwitches).set({ approvalId: a!.id }).where(eq(ruleStepSwitches.id, w!.id));
      await switchAudit(t0, actor, RULE_STEP_AUDIT_RULE_IDS.switchRequested, "require_approval", body.reason, {
        decisionTableId: id,
        decisionTableVersionId: published.id,
        version: published.version,
        switchId: w!.id,
        approvalId: a!.id,
        reviewerUserId: body.reviewerUserId,
        agentId: table.agentId,
        stepName: table.stepName,
        ruleSha256: digest,
      });
      return { status: 202, body: { pending: true, switchId: w!.id, approvalId: a!.id, version: published.version } } as const;
    });
    return reply.status(out.status).send(out.body);
  });

  /** revert a switched table to the AI in one action. No approval: it only takes the table out. Audited. */
  app.post("/v1/decision-tables/:id/revert", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const parsed = revertBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body", issues: parsed.error.issues.slice(0, 20) });
    const userId = req.authCtx.userId ?? null;
    const out = await db.transaction(async (tx) => {
      const t0 = tx as unknown as Db;
      const [table] = await tx.select().from(decisionTables).where(eq(decisionTables.id, id)).for("update");
      if (!table) return { status: 404, body: { error: "unknown_decision_table" } } as const;
      const live = await openTableSwitch(t0, id, ["switched"]);
      const sw = live
        ? await transitionSwitch(t0, live.id, "revert", { revertedBy: userId, revertedAt: sql`now()`, revertReason: parsed.data.reason })
        : null;
      if (!sw) return { status: 409, body: { error: "not_switched", detail: "only a switched table can be reverted" } } as const;
      await switchAudit(t0, userId, RULE_STEP_AUDIT_RULE_IDS.reverted, "allow", parsed.data.reason, {
        decisionTableId: id,
        decisionTableVersionId: sw.decisionTableVersionId,
        switchId: sw.id,
        agentId: table.agentId,
        stepName: table.stepName,
      });
      return { status: 200, body: { id, switch: switchView(sw) } } as const;
    });
    return reply.status(out.status).send(out.body);
  });
}

/**
 * Inside the decide path's transaction (`app.ts`, object_type `rule_step_switch`), for a decision-table switch only.
 * Approved = switched, but only while the version is still the published one, its body still hashes to the digest the
 * request and the approval were bound to, and no detector rule holds the step (else `stale`). Denied = `rejected`.
 */
export async function applyDecisionTableSwitchDecision(
  tx: Db,
  approval: { id: string; stageId: string | null; argumentsDigest: string | null },
  decision: "approved" | "denied",
  deciderUserId: string,
): Promise<void> {
  const switchId = approval.stageId?.startsWith(RULE_STEP_SWITCH_PREFIX) ? approval.stageId.slice(RULE_STEP_SWITCH_PREFIX.length) : null;
  if (!switchId) return;
  const [ref] = await tx
    .select({ versionId: ruleStepSwitches.decisionTableVersionId, tableId: decisionTableVersions.tableId })
    .from(ruleStepSwitches)
    .innerJoin(decisionTableVersions, eq(decisionTableVersions.id, ruleStepSwitches.decisionTableVersionId))
    .where(eq(ruleStepSwitches.id, switchId));
  if (!ref?.versionId) return;
  // serialized with requests, reverts and publishing on the table row; the request and version are read again under it
  const [table] = await tx.select().from(decisionTables).where(eq(decisionTables.id, ref.tableId)).for("update");
  if (!table) return;
  const [w] = await tx.select().from(ruleStepSwitches).where(eq(ruleStepSwitches.id, switchId));
  if (!w || w.status !== "pending_review") return;
  const [v] = await tx.select().from(decisionTableVersions).where(eq(decisionTableVersions.id, ref.versionId));
  if (!v) return;
  const decided = { decidedBy: deciderUserId, decidedAt: sql`now()` };
  const detail = {
    decisionTableId: table.id,
    decisionTableVersionId: v.id,
    version: v.version,
    switchId: w.id,
    approvalId: approval.id,
    agentId: table.agentId,
    stepName: table.stepName,
  };

  if (decision === "denied") {
    if (await transitionSwitch(tx, w.id, "reject", decided)) {
      await switchAudit(tx, deciderUserId, RULE_STEP_AUDIT_RULE_IDS.switchRejected, "deny", "switch denied by the named reviewer; the AI keeps answering", detail);
    }
    return;
  }
  const now = ruleStepRuleDigest(v.body);
  const stillPublished = v.status === "published";
  const held = await suggestionHoldsStep(tx, table.agentId, table.stepName);
  if (!stillPublished || held || now !== w.ruleSha256 || approval.argumentsDigest !== w.ruleSha256) {
    if (await transitionSwitch(tx, w.id, "mark_stale", decided)) {
      await switchAudit(
        tx,
        deciderUserId,
        RULE_STEP_AUDIT_RULE_IDS.switchStale,
        "deny",
        !stillPublished
          ? `switch approved but not applied: version ${v.version} is ${v.status}, not the published version; ask again`
          : held
            ? "switch approved but not applied: the step's detected rule is switched, or asked to be; revert that first"
            : "switch approved but not applied: the table no longer matches what was requested for review; ask again",
        { ...detail, versionStatus: v.status, requestedSha256: w.ruleSha256, approvalSha256: approval.argumentsDigest, ruleSha256: now },
      );
    }
    return;
  }
  if (!(await transitionSwitch(tx, w.id, "approve", decided))) return;
  await switchAudit(
    tx,
    deciderUserId,
    RULE_STEP_AUDIT_RULE_IDS.switched,
    "allow",
    `switch approved by the named reviewer: version ${v.version} of the table answers the inputs it covers and the AI answers the rest`,
    { ...detail, ruleSha256: w.ruleSha256 },
  );
}

/**
 * Called by the decision-table publish path (`applyDecisionTableDecision`) in its transaction, after the old version is
 * superseded: a live switch of that version is reverted, so the new version never answers without its own approved
 * switch, and the step's lifecycle never claims a switch the serve path no longer honours. A pending request for the old
 * version is left for its reviewer; the decide path records it stale.
 */
export async function revertSwitchOfSupersededVersion(
  tx: Db,
  supersededVersionId: string,
  deciderUserId: string,
  detail: { decisionTableId: string; agentId: string; stepName: string; version: number; publishedVersion: number },
): Promise<void> {
  const [live] = await tx
    .select({ id: ruleStepSwitches.id })
    .from(ruleStepSwitches)
    .where(and(eq(ruleStepSwitches.decisionTableVersionId, supersededVersionId), eq(ruleStepSwitches.status, "switched")));
  if (!live) return;
  const reason = `version ${detail.version} was superseded by version ${detail.publishedVersion}; the AI answers again until a switch to the new version is approved`;
  const sw = await transitionSwitch(tx, live.id, "revert", { revertedBy: deciderUserId, revertedAt: sql`now()`, revertReason: reason });
  if (!sw) return;
  await switchAudit(tx, deciderUserId, RULE_STEP_AUDIT_RULE_IDS.reverted, "allow", reason, {
    ...detail,
    decisionTableVersionId: supersededVersionId,
    switchId: sw.id,
  });
}
