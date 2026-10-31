import { describe, expect, it } from "vitest";
import {
  DSR_KINDS,
  DSR_STATUSES,
  DSR_STORES,
  LAWFUL_BASES,
  PRIVACY_DATA_CATEGORIES,
  dsrIdentifierProblem,
} from "../../../../../../packages/shared/src/privacy-ops";
import {
  DATA_CATEGORY_LABELS,
  DSR_KIND_LABELS,
  DSR_STATUS_LABELS,
  DSR_STORE_LABELS,
  LAWFUL_BASIS_LABELS,
  categoryList,
  identifierProblem,
  isOpen,
  widens,
} from "./privacyModel";

const keys = (t: Readonly<Record<string, string>>) => Object.keys(t).sort();

describe("privacy words tables", () => {
  it("name every member of the gateway's vocabularies, and nothing else", () => {
    expect(keys(DATA_CATEGORY_LABELS)).toEqual([...PRIVACY_DATA_CATEGORIES].sort());
    expect(keys(LAWFUL_BASIS_LABELS)).toEqual([...LAWFUL_BASES].sort());
    expect(keys(DSR_KIND_LABELS)).toEqual([...DSR_KINDS].sort());
    expect(keys(DSR_STATUS_LABELS)).toEqual([...DSR_STATUSES].sort());
    expect(keys(DSR_STORE_LABELS)).toEqual([...DSR_STORES].sort());
  });

  it("shows words, never codes", () => {
    expect(categoryList(["email", "credit_card"])).toBe("Email address, Payment card number");
  });
});

describe("the identifier check matches the gateway's", () => {
  it.each([
    ["email", "person@example.com"],
    ["email", "not-an-email"],
    ["phone", "+44 20 7946 0000"],
    ["phone", "12"],
  ] as const)("%s %s", (kind, value) => {
    expect(identifierProblem(kind, value) === null).toBe(dsrIdentifierProblem(kind, value) === null);
  });
});

describe("widens", () => {
  const active = { dataCategories: ["email"], status: "active" as const };
  it("a new record, an added category or a reactivation widens; narrowing does not", () => {
    expect(widens(null, ["email"], "active")).toBe(true);
    expect(widens(active, ["email", "phone"], "active")).toBe(true);
    expect(widens({ ...active, status: "retired" }, ["email"], "active")).toBe(true);
    expect(widens(active, [], "active")).toBe(false);
    expect(widens(active, ["email", "phone"], "retired")).toBe(false);
  });
  it("knows which requests are open", () => {
    expect(isOpen({ status: "in_progress" })).toBe(true);
    expect(isOpen({ status: "rejected" })).toBe(false);
  });
});
