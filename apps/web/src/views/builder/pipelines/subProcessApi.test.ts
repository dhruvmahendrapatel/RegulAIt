import { describe, expect, it } from "vitest";
import { parseStagesText, SUB_PROCESS_STATE_LABEL } from "./subProcessApi";

describe("the sub-process catalogue's client helpers", () => {
  it("parseStagesText accepts a non-empty JSON list and names what is wrong otherwise", () => {
    expect(parseStagesText('[{"id":"plan","type":"planning"}]')).toEqual({ stages: [{ id: "plan", type: "planning" }] });
    expect(parseStagesText("[")).toEqual({ error: "This is not valid JSON." });
    expect(parseStagesText('{"id":"plan"}')).toMatchObject({ error: expect.stringMatching(/JSON list/) });
    expect(parseStagesText("[]")).toEqual({ error: "A sub-process needs at least one stage." });
  });

  it("words every state the kernel declares, and only an approved one reads as ok", () => {
    expect(Object.keys(SUB_PROCESS_STATE_LABEL).sort()).toEqual(["approved", "pending_approval", "rejected"]);
    expect(Object.entries(SUB_PROCESS_STATE_LABEL).filter(([, l]) => l.tone === "ok").map(([k]) => k)).toEqual(["approved"]);
  });
});
