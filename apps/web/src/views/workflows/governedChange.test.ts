/**
 * The governed-change chain and history model: every step comes from the
 * template's own stages, a missing stage is never "done", and history
 * sentences name only what the event carries.
 */
import { describe, expect, it } from "vitest";
import type { WorkflowDetailResponse } from "../../api/types";
import { buildChain, eventSentence, eventTone, sortEvents, stagePhase } from "./governedChange";

const STAGES = [
  { id: "intake", type: "trigger" },
  { id: "plan", type: "planning" },
  { id: "requirements", type: "artifact_generation", output: "requirements" },
  { id: "plan_signoff", type: "human_approval" },
  { id: "agent_build", type: "automated_build" },
  { id: "open_pr", type: "git_operation" },
  { id: "ci", type: "automated_check" },
  { id: "merge_approval", type: "human_approval" },
];

function detail(over: {
  status?: string;
  current?: number;
  statuses?: Record<number, string>;
  stages?: typeof STAGES;
  context?: Record<string, unknown>;
}): WorkflowDetailResponse {
  return {
    instance: {
      id: "00000000-0000-0000-0000-000000000001",
      status: over.status ?? "awaiting_execution",
      createdAt: "2026-11-15T09:00:00Z",
      definition: { stages: over.stages ?? STAGES },
      state: { currentStageIndex: over.current ?? 0, stageStatuses: over.statuses ?? {} },
      context: over.context ?? {},
    },
  };
}

const done = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [i, "completed"]));
const pmNone = { count: 0, loaded: true };

describe("stagePhase", () => {
  it("splits human approvals into the plan sign-off and the merge approval around the first build", () => {
    expect(stagePhase(STAGES, 3)).toBe("sign_off");
    expect(stagePhase(STAGES, 7)).toBe("merge_approval");
    expect(stagePhase(STAGES, 0)).toBeNull();
  });
  it("treats every approval as a sign-off when the template has no build or git stage", () => {
    const stages = [STAGES[1]!, STAGES[3]!, { id: "second", type: "human_approval" }];
    expect(stagePhase(stages, 2)).toBe("sign_off");
  });
});

describe("buildChain", () => {
  it("marks steps done only when every stage in them completed", () => {
    const chain = buildChain(detail({ current: 4, statuses: done(4) }), { count: 1, loaded: true });
    expect(chain.map((c) => [c.id, c.state])).toEqual([
      ["work_item", "done"],
      ["plan", "done"],
      ["sign_off", "done"],
      ["build", "current"],
      ["pull_request", "to_do"],
      ["checks", "to_do"],
      ["merge_approval", "to_do"],
    ]);
  });

  it("never shows a step the template lacks as done", () => {
    const stages = STAGES.filter((s) => s.type !== "automated_check");
    const chain = buildChain(detail({ stages, status: "completed", statuses: done(stages.length) }), pmNone);
    const checks = chain.find((c) => c.id === "checks")!;
    expect(checks.state).toBe("not_in_template");
    // control: the steps the template does have are done
    expect(chain.find((c) => c.id === "build")!.state).toBe("done");
  });

  it("flags the step holding a failed check, in words", () => {
    const chain = buildChain(detail({ current: 6, status: "blocked_on_check", statuses: done(6) }), pmNone);
    const checks = chain.find((c) => c.id === "checks")!;
    expect(checks.state).toBe("attention");
    expect(checks.detail).toBe("Blocked on check");
  });

  it("says no work item is linked, and waits while the links load", () => {
    expect(buildChain(detail({}), pmNone)[0]).toMatchObject({ state: "to_do", detail: "No work item linked" });
    expect(buildChain(detail({}), { count: 0, loaded: false })[0]!.detail).toBe("Loading the linked work items");
    expect(buildChain(detail({}), { count: 2, loaded: true })[0]).toMatchObject({ state: "done", detail: "2 linked work items" });
  });

  it("reports the pull request and the merge from the delivery context", () => {
    const chain = buildChain(
      detail({ status: "completed", statuses: done(8), context: { prUrl: "https://example.test/pr/1", mergeSha: "abc" } }),
      pmNone,
    );
    expect(chain.find((c) => c.id === "pull_request")!.detail).toBe("Opened");
    expect(chain.find((c) => c.id === "merge_approval")!.detail).toBe("Merged");
  });

  it("does not call a terminal instance's last stage in progress", () => {
    const chain = buildChain(detail({ current: 7, status: "completed", statuses: done(7) }), pmNone);
    expect(chain.find((c) => c.id === "merge_approval")!.state).toBe("to_do");
  });
});

describe("history", () => {
  it("writes each event as a sentence that only names what the event carries", () => {
    expect(eventSentence({ kind: "approval_granted", stageId: "plan_signoff" })).toBe("Sign-off granted at Plan sign-off");
    expect(eventSentence({ kind: "check_failed", stageId: "ci", failures: ["lint", "unit"] })).toBe("Checks failed at Ci (2 checks)");
    expect(eventSentence({ kind: "execution_failed", stageId: "agent_build" })).toBe("Stage Agent build failed");
    expect(eventSentence({ kind: "reopen", stageId: "plan_signoff", reason: "recertification" })).toBe(
      "Reopened to Plan sign-off: recertification",
    );
    expect(eventSentence({ kind: "start" })).toBe("Workflow started");
    // an unknown kind is humanised, never dropped
    expect(eventSentence({ kind: "something_new" })).toBe("Something new");
  });

  it("gives failures and refusals a tone, and leaves the rest neutral", () => {
    expect(eventTone("check_failed")).toBe("danger");
    expect(eventTone("approval_returned")).toBe("warn");
    expect(eventTone("approval_granted")).toBe("ok");
    expect(eventTone("start")).toBe("neutral");
  });

  it("orders events oldest first whatever order they arrive in", () => {
    const rows = [
      { id: "b", at: "2026-11-15T10:00:00Z", event: { kind: "approval_granted" } },
      { id: "a", at: "2026-11-15T09:00:00Z", event: { kind: "start" } },
    ];
    expect(sortEvents(rows).map((r) => r.id)).toEqual(["a", "b"]);
    expect(rows[0]!.id).toBe("b"); // the input is not mutated
  });
});
