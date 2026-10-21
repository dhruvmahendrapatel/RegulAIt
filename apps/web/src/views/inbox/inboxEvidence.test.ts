import { describe, expect, it } from "vitest";
import type { WorkflowDetailResponse } from "../../api/types";
import { drawerEvidenceState, mergeGateParts } from "./inboxEvidence";

const inst = (context: Record<string, unknown>, artifacts: unknown[] = []) =>
  ({ instance: { id: "W", context }, artifacts }) as unknown as WorkflowDetailResponse;

describe("mergeGateParts().hasEvidence: true only when MergeGateEvidence renders something", () => {
  it("an instance with no artifacts, PR, branch, checks or dry-run deploy has none", () => {
    expect(mergeGateParts(inst({})).hasEvidence).toBe(false);
    // a deploy that was not a dry run renders nothing, and neither do empty PR and branch strings
    expect(mergeGateParts(inst({ "deploy:dev": { dryRun: false }, prUrl: "", branch: "" })).hasEvidence).toBe(false);
  });
  it("each kind of evidence counts", () => {
    expect(mergeGateParts(inst({}, [{ id: "a", output: "plan", version: 1, content: "x" }])).hasEvidence).toBe(true);
    expect(mergeGateParts(inst({ prUrl: "https://git.example.test/pr/1" })).hasEvidence).toBe(true);
    expect(mergeGateParts(inst({ branch: "feature/x" })).hasEvidence).toBe(true);
    expect(mergeGateParts(inst({ "checks:ci": [{ check: "unit", status: "passed" }] })).hasEvidence).toBe(true);
    expect(mergeGateParts(inst({ "deploy:prod": { dryRun: true } })).hasEvidence).toBe(true);
  });
  it("#473 L2: an empty PR URL with a PR id keeps the PR row, so the #prId badge renders", () => {
    expect(mergeGateParts(inst({ prUrl: "", prId: 7 })).hasPrRow).toBe(true);
    expect(mergeGateParts(inst({ branch: "", prId: 7 })).hasPrRow).toBe(true);
    // a PR id with neither field set at all has nowhere to render
    expect(mergeGateParts(inst({ prId: 7 })).hasPrRow).toBe(false);
  });
});

describe("drawerEvidenceState", () => {
  const base = { toolCall: false, contextConflict: false, fetched: false, inst: undefined, failed: false };
  it("says none when nothing is attached, or when the item's instance is never fetched", () => {
    expect(drawerEvidenceState(base)).toBe("none");
  });
  it("says none for a loaded instance with nothing to show", () => {
    expect(drawerEvidenceState({ ...base, fetched: true, inst: inst({}) })).toBe("none");
  });
  it("never claims none for a failed read or one still loading", () => {
    expect(drawerEvidenceState({ ...base, fetched: true, failed: true })).toBe("failed");
    expect(drawerEvidenceState({ ...base, fetched: true })).toBe("loading");
  });
  it("is shown for a tool call, a context conflict, or an instance with evidence", () => {
    expect(drawerEvidenceState({ ...base, toolCall: true })).toBe("shown");
    expect(drawerEvidenceState({ ...base, contextConflict: true })).toBe("shown");
    expect(drawerEvidenceState({ ...base, fetched: true, inst: inst({ "deploy:prod": { dryRun: true } }) })).toBe("shown");
  });
});
