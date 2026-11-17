import { describe, expect, it } from "vitest";
import { defineMachine, IllegalTransitionError } from "./state-machine.js";
import { MCP_ADMISSION_MACHINE, STATE_MACHINES, TRAINING_JOB_MACHINE } from "./state-machines.js";
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
});
