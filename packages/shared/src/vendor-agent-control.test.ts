/**
 * ADR-0338: the vendor-neutral half of governed vendor agent control. No database.
 */
import { describe, expect, it } from "vitest";
import {
  effectOfDirection,
  killSwitchNarrowingOnly,
  targetStateOf,
  VENDOR_ACTION_MACHINE,
  VENDOR_AGENT_ACTION_STATES,
  type KillSwitchDial,
} from "./vendor-agent-control.js";
import { STATE_MACHINES } from "./state-machines.js";
import { IllegalTransitionError } from "./state-machine.js";

const DIALS: readonly KillSwitchDial[] = ["normal", "read_only", "require_approval", "halted"];

describe("killSwitchNarrowingOnly (owner decision 2)", () => {
  it.each(DIALS)("a narrowing action passes under %s", (dial) => {
    expect(killSwitchNarrowingOnly({ dial, effect: "narrowing" })).toBeNull();
  });

  it("a widening action passes only under normal", () => {
    expect(killSwitchNarrowingOnly({ dial: "normal", effect: "widening" })).toBeNull();
    for (const dial of DIALS.filter((d) => d !== "normal")) {
      expect(killSwitchNarrowingOnly({ dial, effect: "widening" })).toMatch(new RegExp(`'${dial}'`));
    }
  });

  it("apply narrows and reverse widens", () => {
    expect(effectOfDirection("apply")).toBe("narrowing");
    expect(effectOfDirection("reverse")).toBe("widening");
  });
});

describe("the action machine", () => {
  it("is registered and its states are the declared list", () => {
    expect(STATE_MACHINES[VENDOR_ACTION_MACHINE.def.id]).toBe(VENDOR_ACTION_MACHINE);
    expect([...VENDOR_ACTION_MACHINE.def.states]).toEqual([...VENDOR_AGENT_ACTION_STATES]);
  });

  it("follows request, approve, execute, settle", () => {
    expect(VENDOR_ACTION_MACHINE.next("requested", "approve")).toBe("approved");
    expect(VENDOR_ACTION_MACHINE.next("approved", "execute")).toBe("executing");
    expect(VENDOR_ACTION_MACHINE.next("executing", "lose_track")).toBe("unknown");
    expect(VENDOR_ACTION_MACHINE.next("unknown", "succeed")).toBe("succeeded");
    expect(VENDOR_ACTION_MACHINE.next("unknown", "fail")).toBe("failed");
  });

  it("an unknown action is settled by a read, never re-executed", () => {
    expect(VENDOR_ACTION_MACHINE.can("unknown", "execute")).toBe(false);
    expect(VENDOR_ACTION_MACHINE.can("executing", "execute")).toBe(false);
    expect(() => VENDOR_ACTION_MACHINE.next("unknown", "execute")).toThrow(IllegalTransitionError);
  });

  it("expiry and cancel close an open action, and terminal states stay terminal", () => {
    expect(VENDOR_ACTION_MACHINE.sourcesOf("expire")).toEqual(["requested", "approved"]);
    expect(VENDOR_ACTION_MACHINE.sourcesOf("cancel")).toEqual(["requested", "approved"]);
    expect(VENDOR_ACTION_MACHINE.can("executing", "cancel")).toBe(false);
    for (const s of ["succeeded", "already_in_state", "failed", "denied", "cancelled"] as const) {
      expect(VENDOR_ACTION_MACHINE.isTerminal(s)).toBe(true);
      expect(VENDOR_ACTION_MACHINE.events.filter((e) => VENDOR_ACTION_MACHINE.can(s, e))).toEqual([]);
    }
  });

  it("describe reports a guard refusal the server would give", () => {
    const reason = killSwitchNarrowingOnly({ dial: "halted", effect: "widening" })!;
    const view = VENDOR_ACTION_MACHINE.describe("approved", { execute: reason });
    expect(view.transitions.find((t) => t.event === "execute")).toMatchObject({ allowed: false, reason });
  });
});

describe("targetStateOf", () => {
  it("names the state each op leaves the agent in", () => {
    expect(targetStateOf({ action: "quarantine", direction: "apply" })).toBe("quarantined");
    expect(targetStateOf({ action: "disable", direction: "apply" })).toBe("disabled");
    expect(targetStateOf({ action: "quarantine", direction: "reverse" })).toBe("active");
  });
});
