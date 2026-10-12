import { describe, expect, it } from "vitest";
import { ownSubject, type MyConsolidated } from "./MyConsolidatedSpendCard";
import { chatPostBody, postedText } from "../admin/governance/ChatOpsPostAndRoutes";
import { statementExportRefusal } from "../admin/cost/BillingPage";

const data = (subjects: unknown[]): MyConsolidated => ({
  window: { from: "2026-09-12T00:00:00Z", to: "2026-10-12T00:00:00Z" },
  subjects: subjects as never,
  basisStatement: "b",
  note: "n",
});

describe("own consolidated spend", () => {
  it("picks the caller's own subject only; none is null, not zero", () => {
    expect(ownSubject(data([{ subjectId: "other" }]), "me")).toBeNull();
    expect(ownSubject(data([{ subjectId: "me", label: "me@x" }]), "me")?.label).toBe("me@x");
    expect(ownSubject({ ...data([]), subjects: undefined as never }, "me")).toBeNull();
  });
});

describe("chat posting", () => {
  it("sends only what was chosen; an empty choice leaves the gateway's default", () => {
    expect(chatPostBody("", "  ")).toEqual({});
    expect(chatPostBody("eng-slack", " #approvals ")).toEqual({ connectionName: "eng-slack", channel: "#approvals" });
  });
  it("says what the posted card carries", () => {
    expect(postedText({ messageId: "m", redacted: true, decidable: false, messageRef: null })).toBe(
      "The approval's content was withheld (sensitivity fence): the card links to it. It can be decided in the app only.",
    );
    expect(postedText({ messageId: "m", redacted: false, decidable: true, messageRef: "1.2" })).toContain("decide it in chat");
  });
});

describe("billing statement export refusals", () => {
  it("names the scope refusal and the missing statement", () => {
    expect(statementExportRefusal(403, { error: "billing_scope_not_entitled" })).toContain("not entitled");
    expect(statementExportRefusal(404, { error: "unknown_billing_statement" })).toContain("no longer exists");
    expect(statementExportRefusal(500, null)).toBe("The export was refused (HTTP 500)");
  });
});
