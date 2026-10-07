import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MCP_PROTOCOL_GRANT_NAMES, MCP_PROTOCOL_METHODS, MCP_UPSTREAM_TRANSPORTS, coverageChanges, stdioSpecDirty, stdioUpdateOutcome } from "./Batch3Mcp";
import type { McpServer } from "../../../api/adminTypes";
import { ApiError, errMessage } from "../../../api/client";

describe("Batch 3 browser contract", () => {
  const shared = readFileSync(new URL("../../../../../../packages/shared/src/batch3.ts", import.meta.url), "utf8");
  const values = (name: string) => {
    const literal = shared.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`))?.[1];
    expect(literal, `${name} must still exist in the gateway's shared contract`).toBeDefined();
    return [...literal!.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  };
  it("offers exactly the shared methods, grants and transports", () => {
    expect([...MCP_PROTOCOL_METHODS]).toEqual(values("MCP_PROTOCOL_METHODS"));
    expect([...MCP_PROTOCOL_GRANT_NAMES]).toEqual(values("MCP_PROTOCOL_GRANT_NAMES"));
    expect([...MCP_UPSTREAM_TRANSPORTS]).toEqual(values("MCP_UPSTREAM_TRANSPORTS"));
  });
  it("explains an expired conversation and an evidence hold without losing the refusal code", () => {
    expect(errMessage(404, { error: "conversation_expired" })).toContain("Start a new conversation");
    const held = new ApiError(409, { error: "incident_evidence_hold" });
    expect(held.message).toContain("cannot be deleted while the hold applies");
    expect(held.payload.error).toBe("incident_evidence_hold");
  });
  it("explains stdio permission refusals and inactive owners", () => {
    for (const code of ["group_writable", "writable_parent"]) {
      const error = new ApiError(400, { error: "mcp_stdio_command_refused", code });
      expect(error.message).toContain("file and parent-directory write permissions");
      expect(error.payload.code).toBe(code);
    }
    expect(errMessage(422, { error: "owner_inactive" })).toContain("Choose an active person");
  });
  it("sends only the MCP coverage list that was changed (PUT /v1/org/settings is partial)", () => {
    const loaded = { mcpProtocolMethods: ["resources/list"], mcpUpstreamTransports: ["streamable_http"] };
    expect(coverageChanges(loaded, ["resources/list", "prompts/list"], ["streamable_http"], loaded))
      .toEqual({ kind: "save", body: { mcpProtocolMethods: ["resources/list", "prompts/list"] }, adds: true });
    expect(coverageChanges(loaded, ["resources/list"], [], loaded))
      .toEqual({ kind: "save", body: { mcpUpstreamTransports: [] }, adds: false });
    // order is not a change: the stored lists are sets (and nothing needs a re-read)
    expect(coverageChanges({ mcpProtocolMethods: ["a", "b"], mcpUpstreamTransports: [] }, ["b", "a"], [], null))
      .toEqual({ kind: "unchanged" });
  });
  it("a stdio update that changed nothing is not reported as an admission reset (PR #181 review)", () => {
    const before = { id: "s", name: "s", url: "stdio:s", transport: "stdio", stdio: { command: "/opt/mcp/a", args: ["--x"] }, stdioCommandDigest: "d1", admissionState: "admitted" } as McpServer;
    expect(stdioSpecDirty(before, "/opt/mcp/a", ["--x"])).toBe(false);
    expect(stdioSpecDirty(before, "/opt/mcp/a", ["--x", "--y"])).toBe(true);
    expect(stdioSpecDirty(before, "/opt/mcp/b", ["--x"])).toBe(true);
    const same = stdioUpdateOutcome(before, { ...before });
    expect(same).not.toContain("scan required");
    expect(same).toContain("Nothing changed");
    expect(same).toContain("admitted");
    const repinned = stdioUpdateOutcome(before, { ...before, stdioCommandDigest: "d2", admissionState: "unscanned" });
    expect(repinned).toContain("unscanned");
    expect(repinned).toContain("scan and approve");
  });
  it("classifies MCP coverage additions against the lists stored now (PR #181 review)", () => {
    const stale = { mcpProtocolMethods: ["resources/list", "prompts/list"], mcpUpstreamTransports: ["streamable_http"] };
    const now = { mcpProtocolMethods: ["resources/list"], mcpUpstreamTransports: ["streamable_http"] };
    // another admin removed prompts/list; this admin's own addition is what is confirmed
    expect(coverageChanges(stale, ["resources/list", "prompts/list", "completion/complete"], ["streamable_http"], now))
      .toEqual({ kind: "save", body: { mcpProtocolMethods: ["resources/list", "completion/complete"] }, adds: true });
    // this admin removed resources/list: the concurrent removal of prompts/list stays
    expect(coverageChanges(stale, ["prompts/list"], ["streamable_http"], now))
      .toEqual({ kind: "save", body: { mcpProtocolMethods: [] }, adds: false });
    // a change that the stored lists already reflect sends nothing
    expect(coverageChanges(stale, ["resources/list"], ["streamable_http"], now)).toEqual({ kind: "unchanged" });
  });
  it("merges this admin's coverage delta into the re-read lists, keeping a concurrent change (PR #181 review round 4)", () => {
    const loaded = { mcpProtocolMethods: ["resources/list"], mcpUpstreamTransports: ["streamable_http"] };
    const now = { mcpProtocolMethods: ["resources/list", "completion/complete"], mcpUpstreamTransports: ["streamable_http"] };
    // loaded [a], this admin +b, another admin +c meanwhile → a, b, c
    const change = coverageChanges(loaded, ["resources/list", "prompts/list"], ["streamable_http"], now);
    expect(change).toMatchObject({ kind: "save", adds: true });
    expect([...((change as { body: { mcpProtocolMethods: string[] } }).body.mcpProtocolMethods)].sort())
      .toEqual(["completion/complete", "prompts/list", "resources/list"]);
    // a failed re-read never sends the stale full list
    expect(coverageChanges(loaded, ["resources/list", "prompts/list"], ["streamable_http"], null)).toMatchObject({ kind: "error" });
  });
});
