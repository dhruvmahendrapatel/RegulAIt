import { describe, expect, it } from "vitest";
import { describeSchedule, describeScope, formatKeyValues, parseIncludeList, parseKeyValueLines, scopeWidens } from "./discoverySourcesModel";

describe("discovery sources model (ADR-0195 SD0)", () => {
  it("parses key=value lines and refuses malformed ones", () => {
    expect(parseKeyValueLines("org = acme\n\nhost=git.example.test")).toEqual({ value: { org: "acme", host: "git.example.test" } });
    expect(parseKeyValueLines("org")).toEqual({ error: '"org" is not key=value' });
    expect(parseKeyValueLines("1org=x")).toHaveProperty("error");
    expect(parseKeyValueLines("org=a\norg=b")).toEqual({ error: "org is given twice" });
    expect(parseKeyValueLines("org=")).toEqual({ error: "org has no value" });
    expect(formatKeyValues({ org: "acme", host: "h" })).toBe("org=acme\nhost=h");
  });

  it("parses the include list, de-duplicated case-insensitively", () => {
    expect(parseIncludeList("a, b\nA\n\n c ")).toEqual(["a", "b", "c"]);
  });

  it("widening mirrors the gateway rule: org-level and new names widen, removals narrow", () => {
    const list = { orgLevel: false, include: ["a", "b"] };
    expect(scopeWidens(list, { orgLevel: false, include: ["a"] })).toBe(false);
    expect(scopeWidens(list, { orgLevel: false, include: ["a", "c"] })).toBe(true);
    expect(scopeWidens(list, { orgLevel: true, include: [] })).toBe(true);
    expect(scopeWidens({ orgLevel: true, include: [] }, list)).toBe(false);
    expect(scopeWidens(list, { orgLevel: false, include: ["B", "a"] })).toBe(false);
  });

  it("describes scope and schedule", () => {
    expect(describeScope({ orgLevel: true, include: [] })).toMatch(/organisation-level/);
    expect(describeScope({ orgLevel: false, include: ["a", "b", "c", "d", "e"] })).toBe("a, b, c and 2 more");
    expect(describeSchedule(86400)).toBe("daily");
    expect(describeSchedule(3600)).toBe("hourly");
    expect(describeSchedule(7200)).toBe("every 2 hours");
    expect(describeSchedule(172800)).toBe("every 2 days");
  });
});
