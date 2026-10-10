import { describe, expect, it } from "vitest";
import { checkVitestShardCoverage, shardOfName } from "./vitest-shard-coverage.mjs";

// Minimal inputs: `vitest list --filesOnly --json` is an array of { file }, and a
// Vitest JSON report carries one testResults entry per file that ran.
const ROOT = "/w/apps/gateway";
const abs = (f) => `${ROOT}/src/${f}`;
const FILES = ["a.test.ts", "b.test.ts", "nested/c.test.ts", "d.test.ts"];
const fullList = FILES.map((f) => ({ file: abs(f) }));
const shard = (i, n, files) => ({
  name: `gateway-shard-${i}-of-${n}.json`,
  report: { testResults: files.map((f) => ({ name: abs(f), status: "passed", startTime: 0, endTime: 2000 })) },
});
const check = (shards, list = fullList, root = ROOT) => checkVitestShardCoverage(root, list, shards);

describe("vitest-shard-coverage: every gateway test file runs in exactly one shard", () => {
  it("reads the shard from the report's file name", () => {
    expect(shardOfName("gateway-shard-3-of-4.json")).toEqual({ current: 3, total: 4 });
    expect(shardOfName("gateway.json")).toBeNull();
  });

  it("passes when the shards partition the list, and reports per-shard files and seconds", () => {
    const res = check([shard(1, 2, FILES.slice(0, 2)), shard(2, 2, FILES.slice(2))]);
    expect(res.problems).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.perShard).toEqual([
      { shard: "1/2", files: 2, seconds: 4 },
      { shard: "2/2", files: 2, seconds: 4 },
    ]);
  });

  it("compares relative to --root, so reports from another checkout path still match", () => {
    const moved = (i, n, files) => ({
      name: `gateway-shard-${i}-of-${n}.json`,
      report: { testResults: files.map((f) => ({ name: `/other/apps/gateway/src/${f}` })) },
    });
    const res = checkVitestShardCoverage(
      "/other/apps/gateway",
      fullList.map(({ file }) => ({ file: file.replace("/w/", "/other/") })),
      [moved(1, 2, FILES.slice(0, 2)), moved(2, 2, FILES.slice(2))],
    );
    expect(res.ok).toBe(true);
  });

  it("fails when a file ran nowhere", () => {
    const res = check([shard(1, 2, FILES.slice(0, 2)), shard(2, 2, FILES.slice(2, 3))]);
    expect(res.ok).toBe(false);
    expect(res.problems).toContain("never ran in any shard: src/d.test.ts");
  });

  it("fails when a file ran twice, even though the counts still add up", () => {
    // 3 + 1 = 4 = the list's count: a sum-only check would pass this
    const res = check([shard(1, 2, FILES.slice(0, 3)), shard(2, 2, ["a.test.ts"])]);
    expect(res.ok).toBe(false);
    expect(res.problems).toContain("ran 2 times (shards 1, 2): src/a.test.ts");
    expect(res.problems).toContain("never ran in any shard: src/d.test.ts");
  });

  it("fails when a shard ran a file the list does not have", () => {
    const res = check([shard(1, 2, FILES.slice(0, 2)), shard(2, 2, [...FILES.slice(2), "ghost.test.ts"])]);
    expect(res.problems).toContain("ran in a shard but is not in the unsharded list: src/ghost.test.ts");
  });

  it("fails when a shard's report is missing, duplicated or unnamed", () => {
    expect(check([shard(1, 3, FILES.slice(0, 2)), shard(2, 3, FILES.slice(2))]).problems).toContain("shard 3/3 has no report");
    expect(check([shard(1, 2, FILES.slice(0, 2)), shard(1, 2, FILES.slice(2))]).problems).toContain("shard 1/2 was reported twice");
    const unnamed = { name: "gateway.json", report: { testResults: [] } };
    expect(check([unnamed]).problems[0]).toMatch(/does not say which shard/);
    expect(check([shard(1, 2, FILES.slice(0, 2)), shard(2, 3, FILES.slice(2))]).problems).toContain(
      "shard 2/3 disagrees with 2 shards in the first report",
    );
  });

  it("fails on an empty list or a report that is not a Vitest JSON report", () => {
    expect(check([shard(1, 1, [])], []).problems).toContain("the unsharded list has no test files — nothing was proven");
    expect(check([{ name: "x-shard-1-of-1.json", report: {} }]).problems).toContain(
      "shard 1/1 report has no testResults (not a Vitest JSON report?)",
    );
  });

  it("refuses a file outside --root rather than comparing a mangled path", () => {
    const res = check([shard(1, 1, FILES)], [...fullList, { file: "/elsewhere/x.test.ts" }]);
    expect(res.problems).toContain(`listed file is outside --root ${ROOT}: /elsewhere/x.test.ts`);
  });
});
