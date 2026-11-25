/**
 * ADR-0356 (lane E37): `pm_work_triggers.state`, a work item handed to RegulAIt from a PM tool. Declared with the
 * ADR-0348 helper so the server's guarded UPDATE, the database trigger and an agent read one table. The migration's
 * CHECK and BEFORE UPDATE trigger hold the same states and moves.
 */
import { defineMachine } from "./state-machine.js";

export const PM_WORK_TRIGGER_MACHINE = defineMachine({
  id: "pm_work_trigger",
  stored: "pm_work_triggers.state",
  states: ["received", "accepted", "denied", "running", "written_back", "failed"],
  initial: ["received"],
  terminal: ["written_back", "failed"],
  transitions: {
    accept: {
      from: ["received"],
      to: "accepted",
      by: ["system"],
      summary: "The person who handed the item over is linked to a RegulAIt user who is entitled to the connection's agent.",
    },
    deny: {
      from: ["received"],
      to: "denied",
      by: ["system"],
      summary: "The person is not linked, is disabled, or is not entitled; nothing is started.",
    },
    start: {
      from: ["accepted"],
      to: "running",
      by: ["system"],
      summary: "The assigned workflow started as that person and is linked to the item.",
    },
    write_back: {
      from: ["running", "denied"],
      to: "written_back",
      by: ["system"],
      summary: "The item was told the outcome (the final workflow status, or why nothing started).",
    },
    fail: {
      from: ["received", "accepted", "running", "denied"],
      to: "failed",
      by: ["system"],
      summary: "The hand-over could not be completed (an error, no assigned workflow, an unreadable item, or a reason that could not be posted).",
    },
  },
});
