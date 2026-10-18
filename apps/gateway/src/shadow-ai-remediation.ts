/**
 * ADR-0195 A4 — the shipped default workflow for a shadow-AI remediation, and the shared constants the
 * shadow-AI plan route and the workflow start route both read.
 *
 * SECURE BY DEFAULT (ADR-0180). Before this, no rule named the change type, so starting the plan's body answered
 * 422 `no_workflow_matches_change`. The default is the strict shape: intake, the forced plan-only stage (ADR-0079),
 * a remediation-plan artifact and a human sign-off. It is installed through the same tables an admin uses, once,
 * the first time it is needed (the ADR-0080 "minted on first use" pattern, so no migration):
 *  - an ACTIVE default stays as it is: an admin who deletes its rule gets 422 again (stricter, never looser);
 *  - an admin RELAXES it by retiring the template (`POST /v1/workflows/templates/:id/retire`, audited as
 *    `workflow-template-retired`): the retirement deletes the default's change-type rule in the same transaction
 *    (the rule ids ride the audit row), so the admin's own assignment then decides alone. A retired default is never
 *    re-installed, so the retirement stands;
 *  - it is never installed over an admin's decision: once any rule names the change type, nothing is installed;
 *  - its sign-off is by an admin OTHER than the initiator (`admin_not_initiator`, quorum any). An admin who wants
 *    the initiator to sign off authors their own template through the audited template path.
 *
 * This module imports no route module, so the workflow start route can call it without an import cycle.
 */
import { auditLog, deployTargets, eq, isNotNull, workflowAssignmentRules, workflowTemplates, type Db } from "@regulait/db";
import { APPROVER_ADMIN_NOT_INITIATOR } from "./workflow-approvers.js";
import { validateDefinition, type WorkflowDefinition } from "@regulait/workflow-kernel";

/** the change type a shadow-AI remediation workflow is started under */
export const SHADOW_AI_REMEDIATION_CHANGE_TYPE = "shadow-ai-remediation";
/** the environment the plan body carries until the person states where the usage runs (`needsInput`) */
export const SHADOW_AI_REMEDIATION_ENVIRONMENT_UNSTATED = "unstated";
/** the name of the shipped default template (unique even once retired) */
export const SHADOW_AI_REMEDIATION_TEMPLATE_NAME = "shadow-ai-remediation";
/** audit rule id of the one-time install of the default template and rule */
export const SHADOW_AI_REMEDIATION_DEFAULT_INSTALLED = "shadow-ai-remediation-default-installed";
/** the same shape the workload-identity environments CHECK accepts */
export const REMEDIATION_ENVIRONMENT_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

/**
 * The terminal workflow statuses that leave a finding unremediated (the engine's terminals are these plus
 * `completed`). A workflow in one of them is never linked to a finding, and a finding already linked to one may take a
 * new remediation workflow through the audited replace on the link route. `completed` is the successful end: it stays
 * linkable and a link to it is never replaced.
 */
export const UNSUCCESSFUL_TERMINAL_STATUSES = ["denied", "aborted", "rolled_back"] as const;
export const endedUnsuccessfully = (status: string): boolean =>
  (UNSUCCESSFUL_TERMINAL_STATUSES as readonly string[]).includes(status);

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * The finding reference every remediation workflow's description carries. It is how the plan finds a workflow
 * that was started for the finding but never linked (the screen's retry survives a reload without browser storage).
 */
export function remediationReference(findingId: string): string {
  return `shadow-AI finding ${findingId}`;
}

/** the strict default: intake → forced plan-only → the remediation plan as an artifact → a sign-off by an admin
 * other than the initiator (one is enough) */
export function shadowAiRemediationDefinition(): WorkflowDefinition {
  return validateDefinition({
    workflow: SHADOW_AI_REMEDIATION_TEMPLATE_NAME,
    stages: [
      { id: "intake", type: "trigger" },
      { id: "plan", type: "planning" },
      { id: "remediation_plan", type: "artifact_generation", output: "shadow_ai_remediation_plan" },
      { id: "signoff", type: "human_approval", approvers: [APPROVER_ADMIN_NOT_INITIATOR], quorum: "any" },
    ],
  });
}

export type RemediationDefaultState = "active" | "retired" | "not_installed";

/** where the default stands, without changing anything (the plan route reads this) */
export async function shadowAiRemediationDefaultState(db: Db): Promise<RemediationDefaultState> {
  const [row] = await db
    .select({ retiredAt: workflowTemplates.retiredAt })
    .from(workflowTemplates)
    .where(eq(workflowTemplates.name, SHADOW_AI_REMEDIATION_TEMPLATE_NAME));
  if (!row) return "not_installed";
  return row.retiredAt ? "retired" : "active";
}

/**
 * Installs the default template and its change-type rule the first time a remediation workflow is started.
 * Idempotent and race-safe (the template name is unique): only the caller whose insert wins writes the rule and
 * the audit row. Once the name exists, active or retired, nothing is changed; nor when an admin's rule already names
 * the change type (their assignment decides, and the default's stages are never unioned into it).
 */
export async function ensureShadowAiRemediationDefault(db: Db, actorUserId: string | null): Promise<{ installed: boolean }> {
  if ((await shadowAiRemediationDefaultState(db)) !== "not_installed") return { installed: false };
  const definition = shadowAiRemediationDefinition();
  return db.transaction(async (tx) => {
    const [adminRule] = await tx
      .select({ id: workflowAssignmentRules.id })
      .from(workflowAssignmentRules)
      .where(eq(workflowAssignmentRules.changeType, SHADOW_AI_REMEDIATION_CHANGE_TYPE))
      .limit(1);
    if (adminRule) return { installed: false };
    const [template] = await tx
      .insert(workflowTemplates)
      .values({ name: SHADOW_AI_REMEDIATION_TEMPLATE_NAME, definition })
      .onConflictDoNothing({ target: workflowTemplates.name })
      .returning({ id: workflowTemplates.id });
    if (!template) return { installed: false };
    const [rule] = await tx
      .insert(workflowAssignmentRules)
      .values({ templateId: template.id, changeType: SHADOW_AI_REMEDIATION_CHANGE_TYPE })
      .returning({ id: workflowAssignmentRules.id });
    await tx.insert(auditLog).values({
      userId: actorUserId ?? NIL_UUID,
      objectType: "workflow_template",
      objectId: template.id,
      detail: {
        subsystem: "shadow-ai-discovery",
        templateName: SHADOW_AI_REMEDIATION_TEMPLATE_NAME,
        ruleId: rule!.id,
        changeType: SHADOW_AI_REMEDIATION_CHANGE_TYPE,
        stages: definition.stages.map((s) => s.type),
      },
      effect: "allow",
      ruleId: SHADOW_AI_REMEDIATION_DEFAULT_INSTALLED,
      ruleChain: [],
      reason:
        `the shipped default workflow for change type '${SHADOW_AI_REMEDIATION_CHANGE_TYPE}' was installed ` +
        "(plan-only and a sign-off by an admin other than the initiator); an admin relaxes it by retiring the template",
    });
    return { installed: true };
  });
}

/**
 * Retiring the shipped default also deletes its rules, in the retire route's transaction, so an admin's own
 * assignment decides alone afterwards (a rule left on a retired template refuses every start). Returns the deleted
 * rule ids for the retirement's audit row; any other template is untouched (an empty list).
 */
export async function deleteRulesOfRetiredDefault(tx: Db, template: { id: string; name: string }): Promise<string[]> {
  if (template.name !== SHADOW_AI_REMEDIATION_TEMPLATE_NAME) return [];
  const deleted = await tx
    .delete(workflowAssignmentRules)
    .where(eq(workflowAssignmentRules.templateId, template.id))
    .returning({ id: workflowAssignmentRules.id });
  return deleted.map((r) => r.id).sort();
}

/**
 * The environments a remediation may name: those an admin has already given a meaning to, on a deploy target or
 * an assignment rule. There is no shipped list, so with none configured every stated environment is refused.
 */
export async function allowedRemediationEnvironments(db: Db): Promise<string[]> {
  const [targets, rules] = await Promise.all([
    db.selectDistinct({ e: deployTargets.environment }).from(deployTargets).where(isNotNull(deployTargets.environment)),
    db
      .selectDistinct({ e: workflowAssignmentRules.environment })
      .from(workflowAssignmentRules)
      .where(isNotNull(workflowAssignmentRules.environment)),
  ]);
  const all = new Set<string>();
  for (const r of [...targets, ...rules]) {
    if (r.e && r.e !== SHADOW_AI_REMEDIATION_ENVIRONMENT_UNSTATED && REMEDIATION_ENVIRONMENT_PATTERN.test(r.e)) all.add(r.e);
  }
  return [...all].sort();
}
