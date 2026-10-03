/** UXJ-08 — a step's live evidence reads as sentences, never as JSON. */
import { describe, expect, it } from "vitest";
import { evidenceLines } from "./FirstRunPage";

describe("evidenceLines", () => {
  it("names each field and counts or lists its value", () => {
    expect(evidenceLines({ enabledProviders: [], totalConfigured: 0 })).toEqual(["Enabled providers: none", "Total configured: 0"]);
    expect(evidenceLines({ activeNonAdminUsers: 3 })).toEqual(["Active non admin users: 3"]);
    expect(evidenceLines({ providers: ["mock", "openai"], starterTemplatesPresent: ["Reviewer"] })).toEqual([
      "Providers: mock, openai",
      "Starter templates present: Reviewer",
    ]);
  });
  it("passes a note through as the sentence it already is", () => {
    expect(evidenceLines({ note: "a platform credential is stored but the data key is not set" })).toEqual([
      "a platform credential is stored but the data key is not set",
    ]);
  });
  it("never emits braces or quotes", () => {
    for (const line of evidenceLines({ a: true, b: null, c: "x", d: [1, 2] })) expect(line).not.toMatch(/[{}"]/);
  });
});
