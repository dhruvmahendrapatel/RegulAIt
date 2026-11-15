/**
 * ADR-0297 review finding 1–3: the required-tests editor resolves a stored 2025 OWASP LLM id through the alias the
 * gateway sends, so a 2025 row keeps its name and its threshold kind, de-duplicates against its 2026 id, and shows
 * its edition.
 */
import { describe, expect, it } from "vitest";
import { owaspShort, testClassIndex, type TestClassInfo } from "./RequiredTestsEditor";

const catalog: TestClassInfo[] = [
  { id: "owasp:llm:2026:01", name: "Prompt Injection", list: "owasp-llm-top-10", redteamClasses: ["prompt_injection"], scorerKinds: [], measurable: true, legacyId: "owasp:llm:01" },
  { id: "owasp:llm:2026:03", name: "Excessive Agency", list: "owasp-llm-top-10", redteamClasses: ["tool_abuse"], scorerKinds: [], measurable: true, legacyId: "owasp:llm:06" },
  { id: "owasp:agentic:asi02", name: "ASI02: Tool Misuse and Exploitation", list: "owasp-agentic-top-10", redteamClasses: ["tool_abuse"], scorerKinds: [], measurable: true },
];

describe("testClassIndex", () => {
  it("indexes each entry under its 2026 id and its 2025 alias, to the same entry", () => {
    const idx = testClassIndex(catalog);
    expect(idx.get("owasp:llm:01")).toBe(idx.get("owasp:llm:2026:01"));
    expect(idx.get("owasp:llm:06")?.id).toBe("owasp:llm:2026:03");
    // a 2025 default row is a red-team class, so the editor saves it with maxAsr, which the gateway accepts
    expect(idx.get("owasp:llm:06")?.redteamClasses.length).toBeGreaterThan(0);
    expect(idx.get("owasp:agentic:asi02")?.id).toBe("owasp:agentic:asi02");
    expect(idx.get("owasp:llm:03")).toBeUndefined(); // 2025 LLM03 is not in this catalog slice
  });
});

describe("owaspShort", () => {
  it("shows each LLM id with its edition, and agentic ids bare", () => {
    expect(owaspShort("owasp:llm:2026:03")).toBe("LLM03:2026");
    expect(owaspShort("owasp:llm:03")).toBe("LLM03:2025");
    expect(owaspShort("owasp:agentic:asi02")).toBe("ASI02");
    expect(owaspShort("custom:thing")).toBe("custom:thing");
  });
});
