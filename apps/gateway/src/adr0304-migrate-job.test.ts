import { describe, expect, it } from "vitest";
import { runMigrateJob } from "./migrate-job-run.js";

describe("ADR-0304 migrate-job", () => {
  const harness = (fail = false) => {
    const lines: string[] = [];
    const calls: string[] = [];
    return {
      lines,
      calls,
      deps: {
        connect: (url: string) => {
          calls.push(`connect ${url}`);
          return { close: async () => void calls.push("close") };
        },
        migrate: async () => {
          calls.push("migrate");
          if (fail) throw new Error("Failed query: x", { cause: new Error("lock timeout") });
        },
        log: (l: string) => void lines.push(l),
      },
    };
  };

  it("refuses without DATABASE_URL and never connects", async () => {
    const h = harness();
    expect(await runMigrateJob({}, h.deps)).toBe(2);
    expect(h.calls).toEqual([]);
  });

  it("migrates and closes the pool", async () => {
    const h = harness();
    expect(await runMigrateJob({ DATABASE_URL: "postgres://x" }, h.deps)).toBe(0);
    expect(h.calls).toEqual(["connect postgres://x", "migrate", "close"]);
  });

  it("exits non-zero on a failed migration and still closes", async () => {
    const h = harness(true);
    expect(await runMigrateJob({ DATABASE_URL: "postgres://x" }, h.deps)).toBe(1);
    expect(h.calls).toEqual(["connect postgres://x", "migrate", "close"]);
    expect(h.lines.join("\n")).toContain("cause: lock timeout");
    expect(h.lines.join("\n")).not.toContain("postgres://x");
  });
});
