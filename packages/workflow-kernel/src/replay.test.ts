/**
 * ADR-0342 — the pure workflow-history replayer: events in, replayed steps (or diverged / too_long) out.
 */
import { describe, expect, it } from "vitest";
import {
  initialState,
  isTerminalStatus,
  REPLAY_EVENTS_MAX,
  replayHistory,
  TERMINAL_STATUSES,
  transition,
  validateDefinition,
  type InstanceState,
  type ReplayEvent,
  type WorkflowEvent,
} from "./index.js";

const DEF = validateDefinition({
  workflow: "replay",
  stages: [
    { id: "intake", type: "trigger" },
    { id: "req", type: "artifact_generation", output: "doc" },
    { id: "signoff", type: "human_approval", approvers: ["requesting_user"] },
    { id: "branch", type: "git_operation", action: "create_branch", connection: "c", repo: "none/app" },
  ],
});
const T0 = Date.parse("2026-10-05T10:00:00Z");
const ev = (event: WorkflowEvent, minute: number): ReplayEvent => ({ event, at: new Date(T0 + minute * 60_000) });
const HISTORY = [
  ev({ kind: "start" }, 0),
  ev({ kind: "artifact_submitted", stageId: "req" }, 10),
  ev({ kind: "approval_returned", stageId: "signoff" }, 30),
  ev({ kind: "artifact_submitted", stageId: "req" }, 40),
  ev({ kind: "approval_granted", stageId: "signoff" }, 60),
  ev({ kind: "execution_succeeded", stageId: "branch" }, 65),
];
const finalOf = (h: readonly ReplayEvent[]): InstanceState => h.reduce((s, x) => transition(DEF, s, x.event).state, initialState(DEF));

describe("replayHistory", () => {
  it("returns every step with the state before and after it, ending at the stored state", () => {
    const r = replayHistory(DEF, HISTORY, finalOf(HISTORY));
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.steps).toHaveLength(HISTORY.length);
    expect(r.steps.map((s) => s.after.status)).toEqual([
      "blocked_on_artifact",
      "blocked_on_approval",
      "blocked_on_artifact",
      "blocked_on_approval",
      "awaiting_execution",
      "completed",
    ]);
    expect(r.steps[0]!.before).toEqual(initialState(DEF));
    for (let i = 1; i < r.steps.length; i++) expect(r.steps[i]!.before).toEqual(r.steps[i - 1]!.after);
    expect(r.final.status).toBe("completed");
  });

  it("re-orders events sharing one timestamp until the kernel accepts them", () => {
    const applied = [ev({ kind: "start" }, 0), ev({ kind: "artifact_submitted", stageId: "req" }, 5), ev({ kind: "approval_granted", stageId: "signoff" }, 5)];
    const stored = [applied[0]!, applied[2]!, applied[1]!]; // as stored: insert order differs from apply order
    const r = replayHistory(DEF, stored, finalOf(applied));
    expect(r.status).toBe("ok");
    if (r.status === "ok") expect(r.steps.map((s) => s.event.kind)).toEqual(["start", "artifact_submitted", "approval_granted"]);
    // events at DIFFERENT times are never re-ordered
    const apart = [applied[0]!, ev({ kind: "approval_granted", stageId: "signoff" }, 4), ev({ kind: "artifact_submitted", stageId: "req" }, 5)];
    expect(replayHistory(DEF, apart, finalOf(applied)).status).toBe("diverged");
  });

  it("is diverged when no order reaches the stored state, or there is no history; too_long past the bound", () => {
    expect(replayHistory(DEF, HISTORY.slice(0, 2), finalOf(HISTORY))).toMatchObject({ status: "diverged" });
    expect(replayHistory(DEF, [], initialState(DEF))).toMatchObject({ status: "diverged", reason: "no events" });
    const long = Array.from({ length: REPLAY_EVENTS_MAX + 1 }, (_, i) => ev({ kind: "start" }, i));
    expect(replayHistory(DEF, long, initialState(DEF))).toEqual({ status: "too_long", events: REPLAY_EVENTS_MAX + 1 });
  });
});

describe("TERMINAL_STATUSES", () => {
  it("is the set the kernel itself treats as terminal", () => {
    expect([...TERMINAL_STATUSES].sort()).toEqual(["aborted", "completed", "denied", "rolled_back"]);
    for (const status of TERMINAL_STATUSES) {
      expect(isTerminalStatus(status)).toBe(true);
      const state: InstanceState = { ...initialState(DEF), status };
      expect(() => transition(DEF, state, { kind: "abort" })).toThrow(/terminal/);
    }
    expect(isTerminalStatus("running")).toBe(false);
  });
});
