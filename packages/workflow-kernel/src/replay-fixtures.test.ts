/**
 * ADR-0349 slice 1: the replay regression check. Every recorded history under `replay-fixtures/` must still fold,
 * under the CURRENT kernel, to the state recorded with it. A kernel change that would move an in-flight instance
 * somewhere else fails here, in CI, before it ships. A fixture is never re-recorded to make this pass: a deliberate
 * behaviour change ships with an ADR that says what happens to instances already in flight (ADR-0349 decision 1).
 *
 * The replay is ADR-0342's `replayHistory` (the one replayer, shared with process analytics). A fixture's events are
 * in applied order, so each gets its own timestamp and no tie group is re-ordered.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  replayHistory,
  validateDefinition,
  type InstanceState,
  type InstanceStatus,
  type WorkflowDefinition,
  type WorkflowEvent,
} from "./index.js";

interface ReplayFixture {
  fixture: 1;
  name: string;
  note: string;
  definition: WorkflowDefinition;
  events: WorkflowEvent[];
  expected: { state: InstanceState; statuses: InstanceStatus[] };
}

const DIR = new URL("../replay-fixtures/", import.meta.url);
const fixtures: ReplayFixture[] = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(new URL(f, DIR), "utf8")) as ReplayFixture);

// Every event kind the kernel accepts. The type check below fails to compile when a kind is added to WorkflowEvent
// without being listed here, and the coverage test then asks for a recorded history that uses it.
const EVENT_KINDS = [
  "start",
  "artifact_submitted",
  "approval_granted",
  "approval_denied",
  "approval_returned",
  "human_trigger",
  "stage_completed",
  "execution_succeeded",
  "execution_failed",
  "check_failed",
  "recheck",
  "deploy_blocked",
  "deploy_override",
  "rolled_back",
  "reopen",
  "abort",
] as const satisfies readonly WorkflowEvent["kind"][];
type UnlistedKind = Exclude<WorkflowEvent["kind"], (typeof EVENT_KINDS)[number]>;
const everyKindListed: [UnlistedKind] extends [never] ? true : never = true;

// Every status an instance can REST in (`running` is only ever transient inside one transition).
const RESTING_STATUSES = [
  "blocked_on_approval",
  "blocked_on_artifact",
  "blocked_on_plan",
  "awaiting_trigger",
  "awaiting_execution",
  "blocked_on_check",
  "blocked_on_deploy",
  "completed",
  "aborted",
  "denied",
  "rolled_back",
] as const satisfies readonly InstanceStatus[];
type UnlistedStatus = Exclude<InstanceStatus, (typeof RESTING_STATUSES)[number] | "running">;
const everyStatusListed: [UnlistedStatus] extends [never] ? true : never = true;

describe("ADR-0349 replay regression: recorded histories reach their recorded state", () => {
  it("has fixtures, each well-formed and uniquely named", () => {
    expect(everyKindListed && everyStatusListed).toBe(true);
    expect(fixtures.length).toBeGreaterThanOrEqual(10);
    expect(new Set(fixtures.map((f) => f.name)).size).toBe(fixtures.length);
    for (const f of fixtures) {
      expect(f.fixture).toBe(1);
      expect(f.events.length).toBe(f.expected.statuses.length);
      expect(f.events[0]?.kind).toBe("start");
    }
  });

  for (const f of fixtures) {
    it(`${f.name}: ${f.note}`, () => {
      // the snapshotted definition is still a valid definition under the current schema (a tightened schema
      // would refuse an in-flight instance's definition wherever it is re-validated: a re-publish, a gallery diff)
      expect(() => validateDefinition(f.definition)).not.toThrow();
      // the replay uses the snapshot as stored, exactly as the gateway does for an in-flight instance
      const history = f.events.map((event, i) => ({ event, at: new Date(Date.UTC(2026, 0, 1) + i * 1000) }));
      const out = replayHistory(f.definition, history, f.expected.state);
      expect(out.status, `${f.name}: ${out.status === "diverged" ? out.reason : out.status}`).toBe("ok");
      if (out.status !== "ok") return;
      // in recorded order (the timestamps are distinct, so nothing was re-ordered), each step rests where it did
      expect(out.steps.map((s) => s.event)).toEqual(f.events);
      expect(out.steps.map((s) => s.after.status)).toEqual(f.expected.statuses);
      // the whole recorded state, not only the parts replayHistory compares (artifact versions, rounds, entries)
      expect(out.final).toEqual(f.expected.state);
    });
  }

  it("a fixture whose first two events share one commit timestamp, stored in the wrong order, still replays", () => {
    // events written in one transaction share now(), so storage may return them out of order; ADR-0342's tie search
    // must recover the applied order (the gap the code review named for fixtures built from scenarios)
    const f = fixtures.find((x) => x.name === "intake-happy-path-completed")!;
    const at = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 1000);
    const history = f.events.map((event, i) => ({ event, at: i < 2 ? at(0) : at(i) }));
    [history[0], history[1]] = [history[1]!, history[0]!];
    // the swapped order alone is not a valid history: with distinct timestamps (no tie to search) it diverges
    const untied = history.map((h, i) => ({ ...h, at: at(i) }));
    expect(replayHistory(f.definition, untied, f.expected.state).status).toBe("diverged");
    const out = replayHistory(f.definition, history, f.expected.state);
    expect(out.status).toBe("ok");
    if (out.status !== "ok") return;
    expect(out.steps.map((s) => s.event)).toEqual(f.events);
    expect(out.final).toEqual(f.expected.state);
  });

  it("together the fixtures use every event kind and rest in every status", () => {
    const kinds = new Set(fixtures.flatMap((f) => f.events.map((e) => e.kind)));
    expect([...EVENT_KINDS].filter((k) => !kinds.has(k))).toEqual([]);
    const statuses = new Set(fixtures.flatMap((f) => f.expected.statuses));
    expect([...RESTING_STATUSES].filter((s) => !statuses.has(s))).toEqual([]);
  });
});
