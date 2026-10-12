/**
 * ADR-0055 §4 — "pull it into governance", as pure functions.
 *
 * `GET /v1/shadow-ai/findings/:id/remediation-plan` composes the steps and a
 * partial change descriptor; it deliberately does NOT start a workflow. The
 * one route that does (`POST /v1/workflows/instances`, `startInstanceSchema`)
 * also needs a description, the paths and the environment, so the form adds
 * those and this builds the full body. `POST …/remediate {instanceId}` then
 * links the finding to the instance (and marks it confirmed).
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
    body: { change: { targetSystem?: string; changeType?: string; repoPath?: string } };
  };
  note: string;
}

export interface StartForm {
  description: string;
  environment: string;
  projectId: string;
}

export const startFormFrom = (plan: RemediationPlan): StartForm => ({
  description: `Pull ${plan.subject} (${plan.provider}) into governance — shadow-AI finding ${plan.findingId}`,
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
      paths: planned.repoPath ? [planned.repoPath] : [],
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
    "No workflow assignment rule covers the change type 'shadow-ai-remediation', so no workflow was started. Add a rule for it under Workflow templates, or link a workflow you started yourself.",
  bootstrap_cannot_initiate: "A workflow has to be started by a named person, not the bootstrap credential.",
};
