// ENG-IMG reproducible builds (ADR-0187 addendum 2026-10-21): the double-build comparison.
import { describe, expect, it } from "vitest";
import { ENGINE_IDS } from "./engine-images-lock.mjs";
import { compareBuilds } from "./engine-images-repro.mjs";

const rec = (engine, over = {}) => ({ engine, inputCommit: "c".repeat(40), sourceDateEpoch: 1700000000, manifestDigest: `sha256:${"1".repeat(64)}`, imageId: `sha256:${"2".repeat(64)}`, ...over });
const all = (b = {}) => Object.fromEntries(ENGINE_IDS.map((id) => [id, { a: rec(id), b: rec(id, b[id]) }]));

describe("ENG-IMG double-build comparison", () => {
  it("identical builds pass for every engine", () => {
    expect(compareBuilds(all()).every((r) => r.ok)).toBe(true);
  });

  it("a different manifest digest or image id fails that engine only", () => {
    const rows = compareBuilds(all({ garak: { manifestDigest: `sha256:${"3".repeat(64)}` }, modelscan: { imageId: `sha256:${"4".repeat(64)}` } }));
    expect(rows.map((r) => [r.engine, r.ok])).toEqual([["promptfoo", true], ["modelscan", false], ["garak", false]]);
    expect(rows[2].why).toMatch(/NOT reproducible/);
  });

  it("builds of different inputs, a missing build or a mislabelled record never pass", () => {
    expect(compareBuilds(all({ promptfoo: { inputCommit: "d".repeat(40) } }))[0].why).toMatch(/different inputs/);
    expect(compareBuilds(all({ promptfoo: { sourceDateEpoch: 1 } }))[0].ok).toBe(false);
    const missing = all();
    delete missing.garak.b;
    expect(compareBuilds(missing)[2].why).toBe("missing build b");
    expect(compareBuilds(all({ modelscan: { engine: "garak" } }))[1].ok).toBe(false);
    expect(compareBuilds({}).every((r) => !r.ok)).toBe(true);
  });
});
