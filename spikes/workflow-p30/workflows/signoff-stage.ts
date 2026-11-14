// P30 spike: one real pillar-2 stage sequence (requirements artifact -> sign-off -> automated checks)
// driven by the real workflow-kernel transition() inside durable steps. Spike code only.
import { createHook } from "workflow";
import {
  validateDefinition,
  initialState,
  transition,
  type InstanceState,
  type WorkflowEvent,
} from "../../../packages/workflow-kernel/src/index.ts";
import { governedStep } from "./governance.ts";

const DEFINITION = {
  workflow: "standard-change-workflow",
  stages: [
    { id: "intake", type: "trigger" },
    { id: "requirements", type: "artifact_generation", output: "requirements.md" },
    { id: "signoff", type: "human_approval", approvers: ["requester"] },
    { id: "checks", type: "automated_check", checks: ["ci", "code_review", "security_scan"] },
  ],
};

export interface StageInput {
  instanceId: string;
  actorId: string;
  request: string;
}

async function kernelStep(state: InstanceState | null, event: WorkflowEvent) {
  "use step";
  return governedStep("kernel.transition", async () => {
    const def = validateDefinition(DEFINITION);
    const from = state ?? initialState(def);
    return transition(def, from, event);
  });
}

async function generateRequirements(request: string) {
  "use step";
  return governedStep("requirements.generate", async () => ({
    name: "requirements.md",
    body: `# Requirements\n\n- goal: ${request.slice(0, 200)}\n- acceptance: checks pass`,
  }));
}

async function runCheck(name: string) {
  "use step";
  return governedStep(`check.${name}`, async () => {
    await new Promise((r) => setTimeout(r, 300)); // stands in for a CI/scan call
    return { name, passed: true };
  });
}

export async function signoffStageWorkflow(input: StageInput) {
  "use workflow";
  let r = await kernelStep(null, { kind: "start" });
  await generateRequirements(input.request);
  r = await kernelStep(r.state, { kind: "artifact_submitted", stageId: "requirements" });
  // kernel now parks at blocked_on_approval; the durable run suspends on a hook.
  const hook = createHook<{ decision: "approve" | "deny"; approverId: string }>({
    token: `signoff:${input.instanceId}`,
  });
  const signoff = await hook;
  r = await kernelStep(r.state, {
    kind: signoff.decision === "approve" ? "approval_granted" : "approval_denied",
    stageId: "signoff",
  });
  if (r.state.status !== "awaiting_execution") return { status: r.state.status, checks: [] };
  // fan-out: the three named checks run as independent durable steps in parallel.
  const checks = await Promise.all(["ci", "code_review", "security_scan"].map((c) => runCheck(c)));
  r = await kernelStep(r.state, { kind: "execution_succeeded", stageId: "checks" });
  return { status: r.state.status, checks, approver: signoff.approverId };
}
