import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LIMITS, lint } from "./coordination.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
/** the checked-in file as read from disk — CRLF on a Windows (autocrlf) checkout */
const onDisk = readFileSync(path.join(here, "..", "AgentCoordination.md"), "utf8");
/** LF-normalised: every mutation below finds its anchor whatever the checkout */
const real = onDisk.replace(/\r\n/g, "\n");

/** `text.replace(find, …)` that FAILS when the anchor is absent — a silent
 * no-op would leave the "bad" input identical to the good one, and the
 * refusal under test would then be asserted against nothing */
function mutate(text, find, replacement) {
  const out = text.replace(find, replacement);
  if (out === text) throw new Error(`mutation anchor not found: ${String(find)}`);
  return out;
}
const NOW = new Date(Date.UTC(2026, 9, 2, 4, 0));

describe("AgentCoordination.md lint", () => {
  it("the checked-in file passes", () => {
    expect(lint(real)).toEqual([]); // the live clock: stale messages fail CI on purpose
  });

  it("lints a CRLF checkout exactly as it lints LF (a Windows autocrlf working tree)", () => {
    const crlf = real.replace(/\n/g, "\r\n");
    expect(lint(crlf, NOW)).toEqual(lint(real, NOW));
    expect(lint(onDisk, NOW)).toEqual(lint(real, NOW));
    const bad = mutate(real, /^(\| Codex \|.*)$/m, "$1\n$1");
    expect(lint(bad.replace(/\n/g, "\r\n"), NOW).join("\n")).toContain("2 row(s) for Codex");
  });

  it("refuses a second Live-status row for an agent (history)", () => {
    const bad = mutate(real, /^(\| Codex \|.*)$/m, "$1\n$1");
    expect(lint(bad, NOW).join("\n")).toContain("2 row(s) for Codex");
  });

  it("refuses an appended second Status line on a task", () => {
    // a synthetic task, so the test never depends on how a live task is worded
    const bad = real + "\n- **X99 — synthetic task**\n  Status: one\n  Status: two\n";
    expect(lint(bad, NOW).join("\n")).toMatch(/task X99 has 2 Status lines/);
    expect(lint(real + "\n- **X99 — synthetic task**\n  Status: one\n", NOW).join("\n")).not.toMatch(/task X99/);
  });

  it("refuses a stale message and an overfull inbox", () => {
    const old = mutate(real, "### To Claude\n", "### To Claude\n- (Codex, 09-30 01:00) ancient\n");
    expect(lint(old, NOW).join("\n")).toContain("older than");
    const many = mutate(real, "### To Claude\n", "### To Claude\n" + "- (Codex, 10-02 03:00) hi\n".repeat(LIMITS.maxMessagesPerInbox + 1));
    expect(lint(many, NOW).join("\n")).toContain("holds");
  });

  it("refuses a file over the line budget", () => {
    expect(lint(real + "\n".repeat(LIMITS.maxLines), NOW).join("\n")).toContain("lines (limit");
  });
});
