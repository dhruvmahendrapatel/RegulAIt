/** ADR-0221 — the supplier-access forms' checks and the questionnaire list's grouping. */
import { describe, expect, it } from "vitest";
import {
  blankQuestion,
  draftsFrom,
  EMPTY_INVITE,
  groupQuestionnaires,
  inviteBody,
  inviteProblems,
  latestLink,
  looksLikeEmail,
  nextQuestionId,
  questionnaireLabel,
  questionProblems,
  questionsBody,
  usableQuestionnaires,
  wholeInRange,
  type SupplierGrant,
  type SupplierQuestionnaire,
} from "./supplierAccessModel";

describe("the invitation form", () => {
  const ok = { ...EMPTY_INVITE, email: " Sam@Supplier.example ", framework: "eu-ai-act" };

  it("prefills the strict defaults: 14 days of access, a 24-hour link, no questionnaire", () => {
    expect(EMPTY_INVITE).toEqual({ email: "", framework: "", questionnaireId: "", accessDays: "14", inviteHours: "24" });
  });
  it("names each field that is wrong", () => {
    expect(inviteProblems(EMPTY_INVITE)).toEqual({
      email: "Enter the supplier contact's email address.",
      framework: "Choose the framework the supplier answers.",
    });
    expect(inviteProblems(ok)).toEqual({});
    expect(inviteProblems({ ...ok, accessDays: "31" }).accessDays).toBe("A whole number of days from 1 to 30.");
    expect(inviteProblems({ ...ok, accessDays: "0" }).accessDays).toBeDefined();
    expect(inviteProblems({ ...ok, accessDays: "2.5" }).accessDays).toBeDefined();
    expect(inviteProblems({ ...ok, inviteHours: "73" }).inviteHours).toBe("A whole number of hours from 1 to 72.");
    expect(inviteProblems({ ...ok, inviteHours: "72" })).toEqual({});
  });
  it("checks the address the way the gateway does", () => {
    expect(looksLikeEmail("a@b")).toBe(true);
    expect(looksLikeEmail("a b@c")).toBe(false);
    expect(looksLikeEmail("a@@c")).toBe(false);
    expect(looksLikeEmail("ab")).toBe(false);
    expect(looksLikeEmail(`${"a".repeat(250)}@b.c`)).toBe(true); // 254 characters, the limit
    expect(looksLikeEmail(`${"a".repeat(251)}@b.c`)).toBe(false);
  });
  it("sends numbers, a trimmed address and null for no questionnaire", () => {
    expect(inviteBody(ok)).toEqual({ email: "Sam@Supplier.example", framework: "eu-ai-act", questionnaireId: null, accessDays: 14, inviteHours: 24 });
    expect(inviteBody({ ...ok, questionnaireId: "q-id", accessDays: " 7 " }).questionnaireId).toBe("q-id");
  });
  it("wholeInRange takes only whole numbers inside the range", () => {
    expect(wholeInRange("1", 1, 72)).toBe(1);
    expect(wholeInRange("72", 1, 72)).toBe(72);
    expect(wholeInRange("", 1, 72)).toBeNull();
    expect(wholeInRange("-1", 1, 72)).toBeNull();
    expect(wholeInRange("1e1", 1, 72)).toBeNull();
  });
});

const q = (over: Partial<SupplierQuestionnaire>): SupplierQuestionnaire => ({
  id: "id",
  name: "Security basics",
  version: 1,
  description: "",
  questions: [],
  createdAt: "2026-10-01T09:00:00Z",
  retiredAt: null,
  ...over,
});

describe("questionnaires", () => {
  it("groups versions by name, newest version first, names in order", () => {
    const rows = [q({ id: "a1", name: "Privacy", version: 1 }), q({ id: "s1", version: 1 }), q({ id: "s3", version: 3 }), q({ id: "s2", version: 2 })];
    expect(groupQuestionnaires(rows).map((g) => [g.name, g.versions.map((x) => x.version)])).toEqual([
      ["Privacy", [1]],
      ["Security basics", [3, 2, 1]],
    ]);
  });
  it("offers only versions that are not retired", () => {
    expect(usableQuestionnaires([q({ id: "a" }), q({ id: "b", retiredAt: "2026-10-02T00:00:00Z" })]).map((x) => x.id)).toEqual(["a"]);
  });
  it("labels a version in words", () => {
    expect(questionnaireLabel({ name: "Security basics", version: 2 })).toBe("Security basics, version 2");
    expect(questionnaireLabel({ name: null, version: null })).toBe("Questionnaire");
  });
});

describe("the questionnaire builder", () => {
  it("numbers new questions with the first free id", () => {
    expect(nextQuestionId([])).toBe("q1");
    expect(nextQuestionId([blankQuestion("q1"), blankQuestion("q3")])).toBe("q2");
  });
  it("names what is wrong with each question and with the list", () => {
    const qs = [
      { ...blankQuestion("q1"), prompt: "Do you encrypt data at rest?" },
      { ...blankQuestion("Q2"), prompt: "x" },
      { ...blankQuestion("q1"), prompt: "dup" },
      { ...blankQuestion("q4") },
    ];
    const p = questionProblems(qs);
    expect(p.list).toBeNull();
    expect(p.byIndex[0]).toMatch(/share this ID/);
    expect(p.byIndex[1]).toMatch(/lower-case letters/);
    expect(p.byIndex[2]).toMatch(/share this ID/);
    expect(p.byIndex[3]).toBe("Write the question.");
    expect(questionProblems([]).list).toBe("Add at least one question.");
    expect(questionProblems([{ ...blankQuestion("q1"), prompt: "ok" }]).byIndex).toEqual([null]);
  });
  it("sends trimmed text and null for no control, and round-trips an existing version", () => {
    const body = questionsBody([{ id: "q1", prompt: " Why? ", help: " ", required: false, allowFile: true, controlRef: "  " }]);
    expect(body).toEqual([{ id: "q1", prompt: "Why?", help: "", required: false, allowFile: true, controlRef: null }]);
    expect(questionsBody(draftsFrom([{ id: "q1", prompt: "Why?", help: "", required: true, allowFile: false, controlRef: "ART-10" }]))).toEqual([
      { id: "q1", prompt: "Why?", help: "", required: true, allowFile: false, controlRef: "ART-10" },
    ]);
  });
});

describe("a grant's sign-in state", () => {
  const grant = (links: SupplierGrant["links"]): SupplierGrant => ({
    id: "g",
    email: "a@b",
    framework: "eu-ai-act",
    questionnaire: null,
    expiresAt: "2026-11-01T00:00:00Z",
    revokedAt: null,
    createdAt: "2026-10-01T00:00:00Z",
    state: "active",
    liveSessions: 0,
    links,
  });
  it("reads the newest link", () => {
    expect(latestLink(grant([]))).toBeNull();
    const older = { id: "1", expiresAt: "2026-10-02T00:00:00Z", usedAt: null, revokedAt: "2026-10-01T10:00:00Z", state: "revoked" as const };
    const newer = { id: "2", expiresAt: "2026-10-03T00:00:00Z", usedAt: "2026-10-02T09:00:00Z", revokedAt: null, state: "used" as const };
    expect(latestLink(grant([older, newer]))?.id).toBe("2");
    expect(latestLink(grant([newer, older]))?.id).toBe("2");
  });
});
