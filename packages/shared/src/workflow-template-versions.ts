/**
 * ADR-0340 slice 3 — the two lifecycles of template versioning for running workflows, declared once (ADR-0348): a
 * governed migration request of a running instance, and a canary over new instances of a template.
 */
import { defineMachine } from "./state-machine.js";

/** `workflow_instance_migrations.status`. Same values as `WORKFLOW_MIGRATION_STATUSES` in @regulait/db. */
export const WORKFLOW_MIGRATION_MACHINE = defineMachine({
  id: "workflow_migration",
  stored: "workflow_instance_migrations.status",
  states: ["pending", "applied", "denied", "stale"],
  initial: ["pending"],
  terminal: ["applied", "denied", "stale"],
  transitions: {
    approve_applied: {
      from: ["pending"],
      to: "applied",
      by: ["approver"],
      summary: "An admin other than the requester approved it and the plan still held under the instance lock; the instance runs the target version.",
    },
    approve_stale: {
      from: ["pending"],
      to: "stale",
      by: ["approver"],
      summary: "Approved, but the instance had moved past the change or its definition changed since the request; nothing changed.",
    },
    deny: { from: ["pending"], to: "denied", by: ["approver"], summary: "An admin refused it; the instance stays on its version." },
  },
});

/** `workflow_template_canaries.status`. Same values as `WORKFLOW_TEMPLATE_CANARY_STATUSES` in @regulait/db. */
export const WORKFLOW_TEMPLATE_CANARY_MACHINE = defineMachine({
  id: "workflow_template_canary",
  stored: "workflow_template_canaries.status",
  states: ["open", "promoted", "rolled_back"],
  initial: ["open"],
  terminal: ["promoted", "rolled_back"],
  transitions: {
    promote: { from: ["open"], to: "promoted", by: ["admin"], summary: "An admin gave a reason; every new instance gets the canary version." },
    rollback: {
      from: ["open"],
      to: "rolled_back",
      by: ["admin"],
      summary: "An admin gave a reason; the stable definition is published again as the next version and serves every new instance.",
    },
  },
});
