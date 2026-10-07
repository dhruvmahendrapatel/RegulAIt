import { describe, expect, it } from "vitest";
import { checkShardCoverage, testsOf } from "./playwright-shard-coverage.mjs";

// Minimal Playwright JSON reports: a file suite holding a describe suite
// holding specs. `ran` adds one result, which is what a shard's report has and
// an unsharded `--list` report does not.
const spec = (file, line, title, ran) => ({
  title,
  file,
  line,
  column: 3,
  tests: [{ projectName: "", results: ran ? [{ status: "passed" }] : [] }],
});
const report = (specsByFile, shard) => ({
  config: shard ? { shard } : {},
  suites: Object.entries(specsByFile).map(([file, specs]) => ({
    title: file,
    file,
    specs: [],
    suites: [{ title: "a journey", file, specs }],
  })),
});

const ALL = [
  ["a.mock.spec.ts", 10, "one"],
  ["a.mock.spec.ts", 20, "two"],
  ["b.mock.spec.ts", 5, "three"],
  ["c.mock.spec.ts", 7, "four"],
];
const byFile = (rows, ran) => {
  const out = {};
  for (const [f, l, t] of rows) (out[f] ??= []).push(spec(f, l, t, ran));
  return out;
};
const fullList = report(byFile(ALL, false));
const shard = (current, total, rows) => report(byFile(rows, true), { current, total });

describe("playwright-shard-coverage: every listed test runs in exactly one shard (ADR-0183 2.4)", () => {
  it("names each test by file and its describe path, not by line", () => {
    expect(testsOf(fullList).map((t) => t.id)).toContain("|a.mock.spec.ts › a journey › two");
    // the same test reported at a different line (a cold transform cache) is the same test
    const moved = report({ "a.mock.spec.ts": [spec("a.mock.spec.ts", 99, "one", true), spec("a.mock.spec.ts", 98, "two", true)] }, { current: 1, total: 2 });
    expect(checkShardCoverage(fullList, [moved, shard(2, 2, ALL.slice(2))]).ok).toBe(true);
  });

  it("passes when the shards partition the list", () => {
    const res = checkShardCoverage(fullList, [shard(1, 2, ALL.slice(0, 2)), shard(2, 2, ALL.slice(2))]);
    expect(res.problems).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.perShard.map((s) => s.tests)).toEqual([2, 2]);
  });

  it("fails when a test ran nowhere (a shard dropped a file)", () => {
    const res = checkShardCoverage(fullList, [shard(1, 2, ALL.slice(0, 2)), shard(2, 2, ALL.slice(2, 3))]);
    expect(res.ok).toBe(false);
    expect(res.problems).toContain("never ran in any shard: |c.mock.spec.ts › a journey › four");
  });

  it("fails when a test ran twice, even though the counts still add up", () => {
    // 3 + 1 = 4 = the list's count: a sum-only check would pass this
    const res = checkShardCoverage(fullList, [shard(1, 2, ALL.slice(0, 3)), shard(2, 2, [ALL[2]])]);
    expect(res.ok).toBe(false);
    expect(res.problems.join("\n")).toMatch(/ran in 2 shards \(1, 2\): .*three/);
    expect(res.problems.join("\n")).toMatch(/never ran in any shard: .*four/);
  });

  it("fails when a shard's report is missing, or reported twice", () => {
    expect(checkShardCoverage(fullList, [shard(1, 3, ALL.slice(0, 2)), shard(2, 3, ALL.slice(2))]).problems).toContain(
      "shard 3/3 has no report",
    );
    expect(
      checkShardCoverage(fullList, [shard(1, 2, ALL.slice(0, 2)), shard(1, 2, ALL.slice(2))]).problems,
    ).toContain("shard 1/2 was reported twice");
  });

  it("fails when a shard lists a test it did not run, or ran one the list does not have", () => {
    const notRun = report(byFile(ALL.slice(2), false), { current: 2, total: 2 });
    expect(checkShardCoverage(fullList, [shard(1, 2, ALL.slice(0, 2)), notRun]).problems.join("\n")).toMatch(
      /has no result \(did not run\)/,
    );
    const extra = shard(2, 2, [...ALL.slice(2), ["d.mock.spec.ts", 1, "five"]]);
    expect(checkShardCoverage(fullList, [shard(1, 2, ALL.slice(0, 2)), extra]).problems.join("\n")).toMatch(
      /is not in the unsharded list: .*five/,
    );
  });

  it("refuses an empty list and an unsharded report passed as a shard", () => {
    expect(checkShardCoverage(report({}), [shard(1, 1, [])]).ok).toBe(false);
    expect(checkShardCoverage(fullList, [report(byFile(ALL, true))]).problems.join("\n")).toMatch(
      /not produced by a sharded run/,
    );
  });
});
