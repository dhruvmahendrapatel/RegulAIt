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
          if (fail) {
            // drizzle's shape: the message quotes the query and every bound value; the cause carries the SQLSTATE
            const cause = Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03", severity: "ERROR" });
            throw Object.assign(new Error("Failed query: insert into t values ($1)\nparams: secret-value", { cause }), {
              query: "insert into t values ($1)",
              params: ["secret-value"],
            });
          }
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
    const out = h.lines.join("\n");
    // ADR-0167 N8 R1: the SQLSTATE names the reason; the query and its bound values never reach the line.
    expect(out).toContain("migrate-job: migration failed");
    expect(out).toContain("SQLSTATE 55P03");
    expect(out).not.toContain("secret-value");
    expect(out).not.toContain("Failed query");
    expect(out).not.toContain("postgres://x");
  });
});
