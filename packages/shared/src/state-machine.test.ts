import { describe, expect, it } from "vitest";
import { defineMachine, IllegalTransitionError } from "./state-machine.js";
import {
  APPROVAL_MACHINE,
  EVAL_RUN_MACHINE,
  INCIDENT_MACHINE,
  MCP_ADMISSION_MACHINE,
  REDTEAM_LIBRARY_MACHINE,
  SHADOW_AI_FINDING_MACHINE,
  STATE_MACHINES,
  TRAINING_JOB_MACHINE,
  USE_CASE_MACHINE,
} from "./state-machines.js";
import { SHADOW_AI_DISPOSITIONS } from "./shadow-ai.js";
import { INCIDENT_STATUSES } from "./accountability.js";
import { MCP_ADMISSION_STATES } from "./mcp-admission.js";

const door = () =>
  defineMachine({
    id: "door",
    stored: "doors.state",
    states: ["closed", "open", "gone"],
    initial: ["closed"],
    terminal: ["gone"],
    transitions: {
      open: { from: ["closed"], to: "open", by: ["user"], summary: "open it" },
      close: { from: ["open"], to: "closed", by: ["user"], summary: "close it" },
      remove: { from: ["closed", "open"], to: "gone", by: ["admin"], summary: "take it away" },
    },
  });

describe("ADR-0348 defineMachine", () => {
  it("answers can / next / sourcesOf from the one table", () => {
    const m = door();
    expect(m.can("closed", "open")).toBe(true);
    expect(m.can("open", "open")).toBe(false);
    expect(m.next("closed", "open")).toBe("open");
    expect(m.sourcesOf("remove")).toEqual(["closed", "open"]);
    expect(m.canMove("open", "gone")).toBe(true);
    expect(m.canMove("gone", "open")).toBe(false);
    expect(m.isTerminal("gone")).toBe(true);
    expect(m.isState("ajar")).toBe(false);
  });

  it("throws a typed error naming the legal sources on an illegal move", () => {
    const m = door();
    try {
      m.next("gone", "open");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(IllegalTransitionError);
      expect((err as IllegalTransitionError).code).toBe("illegal_transition");
      expect((err as IllegalTransitionError).allowedFrom).toEqual(["closed"]);
    }
  });

  it("describes every event with allowed and a reason, including caller refusals", () => {
    const d = door().describe("open", { remove: "only an admin may remove a door" });
    expect(d).toMatchObject({ machine: "door", state: "open", terminal: false });
    const by = Object.fromEntries(d.transitions.map((t) => [t.event, t]));
    expect(by.close).toMatchObject({ allowed: true, to: "closed" });
    expect(by.close!.reason).toBeUndefined();
    expect(by.open).toMatchObject({ allowed: false });
    expect(by.open!.reason).toContain("only from 'closed'");
    expect(by.remove).toMatchObject({ allowed: false, reason: "only an admin may remove a door" });
    const final = door().describe("gone");
    expect(final.terminal).toBe(true);
    expect(final.transitions.every((t) => !t.allowed && t.reason!.includes("final"))).toBe(true);
  });

  it("serialises to plain JSON an agent can read", () => {
    const json = JSON.parse(JSON.stringify(door()));
    expect(json.id).toBe("door");
    expect(json.transitions.remove.from).toEqual(["closed", "open"]);
  });

  it.each([
    ["an unknown state", { transitions: { x: { from: ["nope"], to: "open", by: [], summary: "" } } }],
    ["an outgoing event from a terminal state", { transitions: { x: { from: ["gone"], to: "open", by: [], summary: "" } } }],
    ["a dead end that is not terminal", { terminal: [], transitions: { x: { from: ["closed"], to: "gone", by: [], summary: "" }, y: { from: ["closed"], to: "open", by: [], summary: "" } } }],
    ["an unreachable state", { transitions: { x: { from: ["closed"], to: "gone", by: [], summary: "" } } }],
  ])("refuses a malformed table at definition: %s", (_label, patch) => {
    expect(() =>
      defineMachine({
        id: "bad",
        stored: "t.c",
        states: ["closed", "open", "gone"],
        initial: ["closed"],
        terminal: ["gone"],
        transitions: {},
        ...(patch as object),
      } as never),
    ).toThrow(/state machine 'bad'/);
  });
});

describe("ADR-0348 declared machines", () => {
  it("registers every machine by its id", () => {
    for (const [id, m] of Object.entries(STATE_MACHINES)) expect(m.def.id).toBe(id);
    expect(Object.keys(STATE_MACHINES)).toEqual(expect.arrayContaining(["training_job", "mcp_admission"]));
  });

  it("training_job: every path the code takes is in the table, and a finished job never moves", () => {
    const m = TRAINING_JOB_MACHINE;
    // under-threshold create, approval, run, poll outcomes, cancel (regulait-llm.ts)
    expect(m.next("queued", "start")).toBe("running");
    expect(m.next("pending_approval", "approve")).toBe("queued");
    expect(m.next("pending_approval", "deny")).toBe("cancelled");
    for (const e of ["succeed", "fail", "refuse", "cancel"] as const) expect(m.can("running", e)).toBe(true);
    for (const s of ["pending_approval", "queued", "running"] as const) expect(m.can(s, "cancel")).toBe(true);
    for (const s of m.def.terminal) for (const e of m.events) expect(m.can(s, e)).toBe(false);
    // the race ADR-0348 closes: a cancelled job is never started or marked succeeded
    expect(m.can("cancelled", "start")).toBe(false);
    expect(m.can("cancelled", "succeed")).toBe(false);
  });

  it("mcp_admission: covers every state, and a clearance is granted only from held", () => {
    const m = MCP_ADMISSION_MACHINE;
    expect([...m.def.states]).toEqual([...MCP_ADMISSION_STATES]);
    expect(m.sourcesOf("admin_cleared")).toEqual(["held"]);
    for (const from of MCP_ADMISSION_STATES) {
      expect(m.canMove(from, "held")).toBe(true);
      expect(m.canMove(from, "clean")).toBe(true);
      expect(m.canMove(from, "unscanned")).toBe(true);
    }
    expect(m.canMove("clean", "cleared")).toBe(false);
    expect(m.canMove("cleared", "cleared")).toBe(true);
  });

  it("incident: open, contained and resolved move freely by an edit; close is final; a halt contains only an open one", () => {
    const m = INCIDENT_MACHINE;
    expect([...m.def.states]).toEqual([...INCIDENT_STATUSES]);
    const live = ["open", "contained", "resolved"] as const;
    for (const a of live) for (const b of live) if (a !== b) expect(m.canMove(a, b)).toBe(true);
    for (const a of live) expect(m.can(a, "close")).toBe(true);
    expect(m.sourcesOf("contain_by_halt")).toEqual(["open"]);
    for (const e of m.events) expect(m.can("closed", e)).toBe(false);
  });

  it("eval_run: a running run ends completed or error, and nothing leaves a finished run", () => {
    const m = EVAL_RUN_MACHINE;
    expect(m.next("running", "complete")).toBe("completed");
    expect(m.next("running", "crash")).toBe("error");
    for (const s of m.def.terminal) for (const e of m.events) expect(m.can(s, e)).toBe(false);
  });

  it("use_case: every move the intake sync makes is declared, and a retired use case never moves", () => {
    const m = USE_CASE_MACHINE;
    // statusForInstance (use-cases.ts) maps an instance onto these targets; the sync skips decided sources
    for (const from of ["proposed", "under_review", "needs_info"] as const) {
      for (const to of ["approved", "rejected"] as const) expect(m.canMove(from, to)).toBe(true);
    }
    expect(m.canMove("proposed", "under_review")).toBe(true);
    expect(m.canMove("under_review", "proposed")).toBe(true);
    expect(m.canMove("needs_info", "proposed")).toBe(false); // the sync keeps needs_info rather than rewinding
    expect(m.canMove("approved", "under_review")).toBe(true); // recertification
    for (const e of m.events) expect(m.can("retired", e)).toBe(false);
  });

  it("approval: decided once, spent once, superseded only while live", () => {
    const m = APPROVAL_MACHINE;
    for (const e of ["approve", "deny", "return"] as const) expect(m.sourcesOf(e)).toEqual(["pending"]);
    expect(m.sourcesOf("consume")).toEqual(["approved"]);
    expect(m.sourcesOf("supersede")).toEqual(["pending", "approved"]);
    for (const s of m.def.terminal) for (const e of m.events) expect(m.can(s, e)).toBe(false);
  });

  it("redteam_library: publish only a draft; retire a draft or a published version, for good", () => {
    const m = REDTEAM_LIBRARY_MACHINE;
    expect(m.sourcesOf("publish")).toEqual(["draft"]);
    expect(m.can("published", "retire")).toBe(true);
    expect(m.can("retired", "publish")).toBe(false);
  });

  it("shadow_ai_finding: an admin may revise a disposition in any direction", () => {
    const m = SHADOW_AI_FINDING_MACHINE;
    for (const a of SHADOW_AI_DISPOSITIONS) for (const b of SHADOW_AI_DISPOSITIONS) expect(m.canMove(a, b)).toBe(true);
  });
});
