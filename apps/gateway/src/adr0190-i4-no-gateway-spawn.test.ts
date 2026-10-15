/**
 * ADR-0190 slice I4 — OWNER DECISION 2 as a static guard (no database): third-party code never runs in the
 * gateway's process or host namespaces, so the in-gateway stdio spawn of ADR-0185 is GONE, with no fallback.
 *
 *  - no serving module of the gateway imports a process-spawning API (`node:child_process`) or the MCP SDK's
 *    stdio CLIENT transport (which spawns its server). The only exceptions are command-line tools that are never
 *    part of the serving process (`demo-prepare.ts`, a CLI) and test fixtures under `testing/`;
 *  - the transports module exposes no spawn path and no host opt-in: the stdio branch is the executor session;
 *  - the host opt-in variables of ADR-0185 are read nowhere.
 * The behaviour (a stdio call reaches a sandbox only through an executor, and without one is refused 409 and
 * audited, with zero processes) is pinned on a real database in `zz-adr0190-i4-stdio-move.test.ts`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as transports from "./mcp-transports.js";

const SRC = path.dirname(fileURLToPath(import.meta.url));
/** command-line tools and fixtures, never loaded by the serving process */
const NOT_SERVING = new Set(["demo-prepare.ts"]);

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "testing") continue;
      out.push(...sources(p));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !NOT_SERVING.has(name)) out.push(p);
  }
  return out;
}

describe("no stdio server ever runs on the gateway host (ADR-0190 I4, OWNER DECISION 2)", () => {
  const files = sources(SRC);

  it("scans the serving sources (a guard that scans nothing proves nothing)", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith("mcp-transports.ts"))).toBe(true);
  });

  it("no serving module imports a process-spawning API or the SDK's stdio client transport", () => {
    const offenders = files.filter((f) => {
      const s = readFileSync(f, "utf8");
      return /from\s+["'](node:)?child_process["']/.test(s) || /@modelcontextprotocol\/sdk\/client\/stdio(\.js)?["']/.test(s) || /\bStdioClientTransport\b/.test(s);
    });
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it("the transports module has no spawn path, no process cap and no host opt-in", () => {
    for (const gone of ["acquireStdioSlot", "liveStdioProcesses", "loadStdioHostPolicy", "checkStdioCommand", "STDIO_ALLOWED_DIRS_ENV", "STDIO_MAX_PROCS_ENV"]) {
      expect(transports, gone).not.toHaveProperty(gone);
    }
    expect(transports.STDIO_REFUSAL_CODES).toEqual(["not_absolute", "invalid_argv", "image_unpinned"]);
  });

  it("the ADR-0185 host opt-in variables are read nowhere", () => {
    const readers = files.filter((f) => /REGULAIT_MCP_STDIO_(ALLOWED_DIRS|MAX_PROCS)/.test(readFileSync(f, "utf8")));
    expect(readers.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it("the closure rules: a digest-pinned image, an absolute entry point inside it, a bounded argv", () => {
    const image = `sha256:${"a".repeat(64)}`;
    expect(transports.checkStdioClosure(image, "/srv/mcp/server.js", ["--root", "/work"])).toEqual({ ok: true, image, command: "/srv/mcp/server.js", args: ["--root", "/work"] });
    expect(transports.checkStdioClosure("regulait/mcp-fs:latest", "/srv/x", [])).toMatchObject({ ok: false, code: "image_unpinned" });
    // an ADR-0185 row pinned a file's sha256 as 64 hex, no prefix: no longer a closure image (first load, refused)
    expect(transports.checkStdioClosure("a".repeat(64), "/srv/x", [])).toMatchObject({ ok: false, code: "image_unpinned" });
    expect(transports.checkStdioClosure(image, "srv/x", [])).toMatchObject({ ok: false, code: "not_absolute" });
    expect(transports.checkStdioClosure(image, "/srv/../etc/x", [])).toMatchObject({ ok: false, code: "not_absolute" });
    expect(transports.checkStdioClosure(image, "/srv/x", "--root /srv")).toMatchObject({ ok: false, code: "invalid_argv" });
    expect(transports.checkStdioClosure(image, "/srv/x", ["a\0b"])).toMatchObject({ ok: false, code: "invalid_argv" });
    expect(transports.checkStdioClosure(image, "/srv/x", Array.from({ length: 65 }, () => "x"))).toMatchObject({ ok: false, code: "invalid_argv" });
  });
});
