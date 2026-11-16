/**
 * The governed-change chain and history model: every step comes from the
 * template's own stages, a missing stage is never "done", and history
 * sentences name only what the event carries.
 */
import { describe, expect, it } from "vitest";
import type { WorkflowDetailResponse } from "../../api/types";
import { buildChain, eventSentence, type PmLinksRead, stagePhase } from "./governedChange";

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
const pmNone: PmLinksRead = { state: "ok", links: [] };
const pmLinks = (n: number) => ({ state: "ok" as const, links: Array.from({ length: n }, () => ({})) });

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
    const chain = buildChain(detail({ current: 4, statuses: done(4) }), pmLinks(1));
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

  it("says no work item is linked, and says it does not know while loading, on error, or when hidden", () => {
    expect(buildChain(detail({}), pmNone)[0]).toMatchObject({ state: "to_do", detail: "No work item linked" });
    expect(buildChain(detail({}), pmLinks(2))[0]).toMatchObject({ state: "done", detail: "2 linked work items" });
    expect(buildChain(detail({}), { state: "loading" })[0]).toMatchObject({ state: "unknown", detail: "Reading" });
    expect(buildChain(detail({}), { state: "error" })[0]).toMatchObject({ state: "unknown", detail: "Could not read the linked work items" });
    expect(buildChain(detail({}), { state: "hidden" })[0]).toMatchObject({
      state: "unknown",
      detail: "Not visible to you",
    });
  });

  it("does not count an orphaned link as a linked work item", () => {
    const pm = { state: "ok" as const, links: [{ orphanedAt: "2026-11-15T10:00:00Z" }, {}] };
    expect(buildChain(detail({}), pm)[0]).toMatchObject({ state: "done", detail: "1 linked work item" });
    const allGone = { state: "ok" as const, links: [{ orphanedAt: "2026-11-15T10:00:00Z" }] };
    expect(buildChain(detail({}), allGone)[0]).toMatchObject({ state: "to_do", detail: "No work item linked" });
  });

  it("never shows Checks done when a recorded check failed, even if the kernel completed the stage (rollback)", () => {
    // the kernel marks a failed post-deploy verify completed before it jumps to rollback
    const statuses = done(8);
    const failed = buildChain(
      detail({ status: "rolled_back", current: 7, statuses, context: { "checks:ci": [{ check: "smoke", status: "failed" }, { check: "lint", status: "passed" }] } }),
      pmNone,
    ).find((c) => c.id === "checks")!;
    expect(failed).toMatchObject({ state: "attention", detail: "1 check failed" });
    // rolled back with no failed result on record still needs attention
    const rolled = buildChain(detail({ status: "rolled_back", current: 7, statuses }), pmNone).find((c) => c.id === "checks")!;
    expect(rolled).toMatchObject({ state: "attention", detail: "The change was rolled back" });
    // control: every stage completed, every check passed, not rolled back: done
    const ok = buildChain(
      detail({ status: "completed", statuses, context: { "checks:ci": [{ check: "lint", status: "passed" }] } }),
      pmNone,
    ).find((c) => c.id === "checks")!;
    expect(ok.state).toBe("done");
  });


  it("does not call a terminal instance's last stage in progress", () => {
    const chain = buildChain(detail({ current: 7, status: "completed", statuses: done(7) }), pmNone);
    expect(chain.find((c) => c.id === "merge_approval")!.state).toBe("to_do");
  });
});

describe("history", () => {
  it("writes each event as a sentence that only names what the event carries", () => {
    expect(eventSentence({ kind: "approval_granted", stageId: "plan_signoff" })).toBe("Sign-off granted at plan sign-off");
    expect(eventSentence({ kind: "check_failed", stageId: "ci", failures: ["lint", "unit"] })).toBe("Checks failed at CI (2 checks)");
    // ids are lower-cased mid-sentence, and the server's own error and reason text is never shown
    expect(eventSentence({ kind: "execution_failed", stageId: "agent_build", error: "boom <b>" } as never)).toBe("Stage agent build failed");
    expect(eventSentence({ kind: "reopen", stageId: "plan_signoff", reason: "recertification" } as never)).toBe("Reopened to plan sign-off");
    expect(eventSentence({ kind: "start" })).toBe("Workflow started");
    // an unknown kind is humanised, never dropped
    expect(eventSentence({ kind: "something_new" })).toBe("Something new");
  });


});
