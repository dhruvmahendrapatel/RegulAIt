import { describe, expect, it } from "vitest";
import type { Approval } from "../../api/types";
import { inboxSummary } from "./inboxSummary";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const row = (id: string, dueAt?: string | null, kind = "other") => ({ id, kind, assignment: dueAt === undefined ? undefined : { dueAt } }) as unknown as Approval;
const isIntake = (a: Approval) => (a as unknown as { kind: string }).kind === "intake";
const isTool = (a: Approval) => (a as unknown as { kind: string }).kind === "tool";

describe("inboxSummary", () => {
  it("counts kinds and due buckets on the given clock", () => {
    const s = inboxSummary(
      [
        row("a", "2026-11-13T12:00:00Z", "intake"), // past due
        row("b", "2026-11-14T12:00:00Z", "tool"), // due now: not past due, due soon
        row("c", "2026-11-21T11:59:59Z"), // inside 7 days
        row("d", "2026-11-21T12:00:00Z"), // exactly 7 days: outside
        row("e"), // no assignment
        row("f", null), // assignment without a due date
        row("g", "not a date"),
      ],
      NOW,
      isIntake,
      isTool,
    );
    expect(s).toEqual({ pending: 7, intake: 1, tool: 1, dueSoon: 2, overdue: 1 });
  });

  it("moves an item to past due as the clock advances", () => {
    const rows = [row("a", "2026-11-14T12:30:00Z")];
    expect(inboxSummary(rows, NOW, isIntake, isTool)).toMatchObject({ dueSoon: 1, overdue: 0 });
    expect(inboxSummary(rows, NOW + 60 * 60 * 1000, isIntake, isTool)).toMatchObject({ dueSoon: 0, overdue: 1 });
  });

  it("is all zeros for an empty queue", () => {
    expect(inboxSummary([], NOW, isIntake, isTool)).toEqual({ pending: 0, intake: 0, tool: 0, dueSoon: 0, overdue: 0 });
  });
});
