/**
 * ADR-0055 §4 — "pull it into governance", as pure functions.
 *
 * `GET /v1/shadow-ai/findings/:id/remediation-plan` composes the steps and the
 * request body for the one route that starts workflows (`POST
 * /v1/workflows/instances`, shaped to its `startInstanceSchema`); it does NOT
 * start one itself. The body's environment is a placeholder the server cannot
 * know (`needsInput`), so the form asks for it and may edit the description;
 * the paths, change type and target system are the plan's. `POST …/remediate
 * {instanceId}` then links the finding to the instance (and marks it
 * confirmed). No workflow is assigned to the change type by default: the plan
 * says so (`assignment.ruleConfigured`) before anyone tries.
 */
import type { RefusalSentences } from "./refusalCopy";

export interface RemediationPlan {
  findingId: string;
  subject: string;
  provider: string;
  severity: string;
  replacementAgent: { id: string; name: string; provider: string; enabled: boolean } | null;
  steps: Array<{ step: string; why: string; blocked?: string }>;
  workflowRequest: {
    route: string;
    body: { change: { description: string; paths: string[]; changeType: string; environment: string; targetSystem?: string } };
    /** the body fields only the person can state (the server sends a placeholder) */
    needsInput?: string[];
  };
  /** whether an admin has assigned a workflow to the remediation change type */
  assignment?: { changeType: string; ruleConfigured: boolean; detail?: string };
  note: string;
}

export interface StartForm {
  description: string;
  environment: string;
  projectId: string;
}

export const startFormFrom = (plan: RemediationPlan): StartForm => ({
  description: plan.workflowRequest.body.change.description,
  // no default: where the ungoverned usage runs is a fact the person states
  environment: "",
  projectId: "",
});

export interface StartInstanceBody {
  projectId?: string;
  change: {
    description: string;
    paths: string[];
    changeType: string;
    environment: string;
    targetSystem?: string;
  };
}

/** the plan's change descriptor, completed into what the workflow route accepts */
export function startInstanceBody(plan: RemediationPlan, form: StartForm): { ok: true; body: StartInstanceBody } | { ok: false; problem: string } {
  const description = form.description.trim();
  if (!description) return { ok: false, problem: "Describe the change the workflow is for." };
  const environment = form.environment.trim();
  if (!environment) return { ok: false, problem: "Name the environment the usage runs in (for example production or staging)." };
  const planned = plan.workflowRequest.body.change;
  const targetSystem = (planned.targetSystem ?? plan.subject).trim().slice(0, 200);
  const body: StartInstanceBody = {
    change: {
      description,
      paths: [...planned.paths],
      changeType: planned.changeType || "shadow-ai-remediation",
      environment,
      ...(targetSystem ? { targetSystem } : {}),
    },
  };
  if (form.projectId) body.projectId = form.projectId;
  return { ok: true, body };
}

export const SHADOW_REMEDIATION_REFUSALS: RefusalSentences = {
  unknown_finding: "This finding no longer exists. Reload the inventory.",
  invalid_reference: "That workflow instance does not exist.",
  no_workflow_matches_change:
    "No workflow assignment rule covers the change type 'shadow-ai-remediation', so no workflow was started. None is assigned by default: an admin must add a rule for it under Workflow templates, or you can link a workflow started another way.",
  bootstrap_cannot_initiate: "A workflow has to be started by a named person, not the bootstrap credential.",
};
