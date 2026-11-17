/**
 * ADR-0349 slice 1: the replay regression check. Every recorded history under `replay-fixtures/` must still fold,
 * under the CURRENT kernel, to the state recorded with it. A kernel change that would move an in-flight instance
 * somewhere else fails here, in CI, before it ships. A fixture is never re-recorded to make this pass: a deliberate
 * behaviour change ships with an ADR that says what happens to instances already in flight (ADR-0349 decision 1).
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  replayEvents,
  stateDifference,
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
      const out = replayEvents(f.definition, f.events);
      if (!out.ok) {
        throw new Error(`${f.name}: the kernel now refuses event ${out.index} (${out.event.kind}): ${out.reason}`);
      }
      const firstStep = f.expected.statuses.findIndex((s, i) => out.statuses[i] !== s);
      expect(
        firstStep,
        firstStep < 0 ? "" : `${f.name}: after event ${firstStep} (${f.events[firstStep]!.kind}) the status is now '${out.statuses[firstStep]}', recorded '${f.expected.statuses[firstStep]}'`,
      ).toBe(-1);
      expect(stateDifference(f.expected.state, out.state)).toBeNull();
    });
  }

  it("together the fixtures use every event kind and rest in every status", () => {
    const kinds = new Set(fixtures.flatMap((f) => f.events.map((e) => e.kind)));
    expect([...EVENT_KINDS].filter((k) => !kinds.has(k))).toEqual([]);
    const statuses = new Set(fixtures.flatMap((f) => f.expected.statuses));
    expect([...RESTING_STATUSES].filter((s) => !statuses.has(s))).toEqual([]);
  });
});

describe("replayEvents / stateDifference", () => {
  const def = validateDefinition({
    workflow: "w",
    stages: [
      { id: "t", type: "trigger" },
      { id: "a", type: "artifact_generation", output: "doc" },
      { id: "s", type: "human_approval", approvers: ["requesting_user"] },
    ],
  });

  it("reports a refused event by index instead of throwing", () => {
    const out = replayEvents(def, [{ kind: "start" }, { kind: "approval_granted", stageId: "s" }]);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.index).toBe(1);
      expect(out.statuses).toEqual(["blocked_on_artifact"]);
    }
  });

  it("names the first difference between two states", () => {
    const out = replayEvents(def, [{ kind: "start" }, { kind: "artifact_submitted", stageId: "a" }]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(stateDifference(out.state, out.state)).toBeNull();
    expect(stateDifference(out.state, { ...out.state, currentStageIndex: 0 })).toMatch(/currentStageIndex/);
    expect(stateDifference(out.state, { ...out.state, artifactVersions: {} })).toMatch(/artifactVersions\['doc'\]/);
    expect(stateDifference(out.state, { ...out.state, stageStatuses: ["completed", "completed", "pending"] })).toMatch(/stageStatuses\[2\]/);
  });
});
