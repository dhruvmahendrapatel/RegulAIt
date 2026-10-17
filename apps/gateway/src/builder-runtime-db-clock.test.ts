/**
 * N13 (M-075): every timestamp `builder-runtime.ts` writes to, or compares with, a database row is on the database
 * clock (`sql\`now()\``, or `databaseNow`). The process clock is left only where it measures this process's own
 * time: a lease-wait deadline, call latency, a trace span's start, and `monthStartUtc`'s default (its callers here
 * pass the database's now). A new `new Date()` or `Date.now()` fails this test until it is either moved to the
 * database clock or listed below with its reason.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "builder-runtime.ts"), "utf8");
/** comments stripped, so prose that mentions a clock is not a use of one */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** each allowed process-clock use, as the line it appears on (trimmed) */
const ALLOWED: ReadonlyArray<{ line: string; why: string }> = [
  { line: "export function monthStartUtc(now = new Date()): Date {", why: "a default only; builder-runtime callers pass databaseNow" },
  { line: "const deadline = Date.now() + waitMs;", why: "how long this process waits for a lease" },
  { line: "if (Date.now() >= deadline) return null;", why: "the same wait" },
  { line: "const at = new Date();", why: "a trace span's start, timed with the other spans of this process" },
  { line: "const started = Date.now();", why: "call latency" },
  { line: "const latencyMs = Date.now() - started;", why: "call latency" },
];

describe("builder-runtime uses the database clock for database timestamps (M-075)", () => {
  it("no process-clock use outside the allowed list", () => {
    const uses = CODE.split("\n")
      .map((l) => l.trim())
      .filter((l) => /\bnew Date\(\)|\bDate\.now\(\)/.test(l));
    const allowed = new Set(ALLOWED.map((a) => a.line));
    expect(uses.filter((l) => !allowed.has(l))).toEqual([]);
    expect(uses.length).toBeGreaterThan(0); // non-vacuous: the scan sees the allowed uses
  });

  it("no row timestamp is written from the process clock", () => {
    expect(CODE).not.toMatch(/\b(updatedAt|createdAt|finishedAt|lastRunAt|decidedAt)\s*:\s*new Date\(/);
    expect(CODE).toMatch(/updatedAt: sql`now\(\)`/);
  });

  it("the paused-approval expiry and the monthly window are judged on the database clock", () => {
    expect(CODE).toMatch(/apExpired: sql<boolean>`coalesce\(\$\{approvals\.expiresAt\} <= now\(\), false\)`/);
    expect(CODE).not.toMatch(/monthStartUtc\(\)/);
    expect(CODE).toMatch(/opts\.now \?\? \(await databaseNow\(db\)\)/);
  });
});
