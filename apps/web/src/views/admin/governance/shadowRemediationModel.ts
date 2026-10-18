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
 * confirmed). ADR-0195 A4: a strict default workflow (plan-only, then a human
 * sign-off) is installed for the change type on the first start; the plan says
 * when it was retired and nothing else is assigned (`assignment`). A workflow
 * that started but never linked comes back from the server as `pendingLink`,
 * so the "retry the link, never start another" state survives a reload.
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
  /** whether a workflow is assigned to the remediation change type, and where the shipped default stands */
  assignment?: {
    changeType: string;
    ruleConfigured: boolean;
    defaultTemplate?: { name: string; state: "active" | "retired" | "not_installed" };
    detail?: string;
  };
  /** a workflow started for this finding whose link never landed */
  pendingLink?: { instanceId: string; startedAt: string } | null;
  /** the workflow the finding is linked to; `replaceable` when it ended denied, aborted or rolled back */
  currentLink?: { instanceId: string; status: string | null; replaceable: boolean } | null;
  note: string;
}

/** the reference every remediation workflow's description carries (how the server finds an unlinked start) */
export const remediationReference = (findingId: string) => `shadow-AI finding ${findingId}`;

/** the terminal statuses that leave a finding unremediated (the gateway's UNSUCCESSFUL_TERMINAL_STATUSES): never
 * linkable, and a finding linked to one may take a new workflow. `completed` is the successful end */
export const UNSUCCESSFUL_TERMINAL_STATUSES: readonly string[] = ["denied", "aborted", "rolled_back"];

/** the workflows the link route can accept for this finding: a live (or completed) remediation workflow started from
 * its plan. The server also requires the viewer to be its initiator, and refuses a finding whose link still stands */
export const linkableInstances = <T extends { status: string; change?: { description?: string; changeType?: string } }>(
  findingId: string,
  instances: readonly T[],
): T[] =>
  instances.filter(
    (i) =>
      !UNSUCCESSFUL_TERMINAL_STATUSES.includes(i.status) &&
      i.change?.changeType === "shadow-ai-remediation" &&
      (i.change.description ?? "").includes(remediationReference(findingId)),
  );

/** true while the finding's link stands: linked to a workflow that has not ended denied, aborted or rolled back */
export const linkStands = (plan: RemediationPlan): boolean => !!plan.currentLink && !plan.currentLink.replaceable;

/** the environment placeholder the server sends until one is stated; the start route refuses it */
export const ENVIRONMENT_UNSTATED = "unstated";

/** false only when a start is known to find no workflow: no rule names the change type and the default is not coming */
export const startWillMatch = (plan: RemediationPlan): boolean =>
  !plan.assignment || plan.assignment.ruleConfigured || plan.assignment.defaultTemplate?.state === "not_installed";

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
  if (!environment || environment === ENVIRONMENT_UNSTATED) {
    return { ok: false, problem: "Name the environment the usage runs in (for example production or staging)." };
  }
  const planned = plan.workflowRequest.body.change;
  const targetSystem = (planned.targetSystem ?? plan.subject).trim().slice(0, 200);
  // the finding reference stays on the description whatever the person typed
  const reference = remediationReference(plan.findingId);
  const body: StartInstanceBody = {
    change: {
      description: description.includes(reference) ? description : `${description} — ${reference}`,
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
    "No workflow assignment rule covers the change type 'shadow-ai-remediation', so no workflow was started. Its default workflow has been retired or unassigned: an admin must add a rule for it under Workflow templates, or you can link a workflow started another way.",
  template_retired:
    "The workflow assigned to 'shadow-ai-remediation' is retired, so no workflow was started. An admin must assign an active one under Workflow templates, or you can link a workflow started another way.",
  environment_unstated: "Name the environment the usage runs in before starting the workflow.",
  environment_not_allowed: "That environment is not one a deploy target or workflow assignment rule uses.",
  bootstrap_cannot_initiate: "A workflow has to be started by a named person, not the bootstrap credential.",
  not_your_workflow: "Only the person who started a remediation workflow can link it to a finding.",
  workflow_not_linkable:
    "That workflow cannot be linked: it must be a remediation workflow started from this finding's plan that was not denied, aborted or rolled back.",
  already_linked:
    "This finding is already linked to a remediation workflow. A new one can replace it only once that workflow is denied, aborted or rolled back.",
  instance_already_linked: "That workflow is already linked to another finding.",
};
