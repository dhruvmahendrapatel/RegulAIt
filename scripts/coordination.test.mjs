import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LIMITS, lint } from "./coordination.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const real = readFileSync(path.join(here, "..", "AgentCoordination.md"), "utf8");
const NOW = new Date(Date.UTC(2026, 9, 2, 4, 0));

describe("AgentCoordination.md lint", () => {
  it("the checked-in file passes", () => {
    expect(lint(real)).toEqual([]); // the live clock: stale messages fail CI on purpose
  });

  it("refuses a second Live-status row for an agent (history)", () => {
    const bad = real.replace(/^(\| Codex \|.*)$/m, "$1\n$1");
    expect(lint(bad, NOW).join("\n")).toContain("2 row(s) for Codex");
  });

  it("refuses an appended second Status line on a task", () => {
    const bad = real.replace(/^(- \*\*C1 — [^\n]*\n)/m, "$1  Status: one\n  Status: two\n");
    expect(lint(bad, NOW).join("\n")).toMatch(/task C1 has \d+ Status lines/);
  });

  it("refuses a stale message and an overfull inbox", () => {
    const old = real.replace("### To Claude\n", "### To Claude\n- (Codex, 09-30 01:00) ancient\n");
    expect(lint(old, NOW).join("\n")).toContain("older than");
    const many = real.replace("### To Claude\n", "### To Claude\n" + "- (Codex, 10-02 03:00) hi\n".repeat(LIMITS.maxMessagesPerInbox + 1));
    expect(lint(many, NOW).join("\n")).toContain("holds");
  });

  it("refuses a file over the line budget", () => {
    expect(lint(real + "\n".repeat(LIMITS.maxLines), NOW).join("\n")).toContain("lines (limit");
  });
});
