import { describe, expect, it } from "vitest";
import {
  couldNotRead,
  describeSchedule,
  describeScope,
  editablePublicConfig,
  formatKeyValues,
  parseIncludeList,
  parseKeyValueLines,
  scopeWidens,
  sightingLines,
} from "./discoverySourcesModel";

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

  it("leaves server-generated keys out of a replacement's pre-fill", () => {
    expect(editablePublicConfig({ roleArn: "arn:aws:iam::000000000000:role/r", externalId: "regulait-x" })).toEqual({ roleArn: "arn:aws:iam::000000000000:role/r" });
  });

  it("says what could not be read, or nothing when everything was", () => {
    expect(couldNotRead([{ read: "repos", status: "read" }])).toBeNull();
    expect(couldNotRead([{ read: "trail", status: "not_enabled" }, { read: "logs", status: "denied", detail: "403" }])).toBe(
      "could not read: trail (not enabled); logs (denied: 403)",
    );
  });

  it("renders sightings: location, names, actor; skips bare ones", () => {
    const psn = `psn:${"ab".repeat(12)}`;
    expect(sightingLines([{ source: "egress_log" }])).toEqual([]);
    expect(
      sightingLines([{ source: "repo_scan", location: { path: "src/a.ts", line: 3, commit: "0123456789abcdef" }, names: ["OPENAI_API_KEY"], actor: psn }]),
    ).toEqual([{ text: "src/a.ts:3 @01234567 · names: OPENAI_API_KEY", actor: psn }]);
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
